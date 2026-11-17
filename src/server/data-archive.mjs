/**
 * Data-dir export/import archive (remote-server plan, phase 4): a minimal
 * ustar writer and reader with gzip from node:zlib. No npm dependency, plain
 * ESM JS, so Next routes, the Electron .cjs shell (via import()) and
 * scripts/data-archive.mjs all load the same code.
 *
 *   const gz = createArchive(PATHS.data);          // Buffer (.tar.gz)
 *   extractArchive(gz, stagingDir);                // into a NEW or EMPTY dir
 *   importArchive(gz, PATHS.data, { carry });      // stage, check, back up, swap
 *
 * Entry rules (both directions):
 *  - Regular files and directories only. Symlinks, hard links, devices,
 *    FIFOs, pax/GNU extension headers are refused (DataArchiveError).
 *  - Relative names only: no absolute path, no drive letter, no backslash,
 *    no NUL, no empty, "." or ".." segment. Names must fit the ustar
 *    name (100 bytes) + prefix (155 bytes) split.
 *  - The uncompressed tar stream is capped (default 256 MB). The gunzip is
 *    bounded too, so a gzip bomb stops at the cap.
 *  - Credential-like files (auth.json*, *-credentials.json*, .env*) are
 *    never written into an archive and never extracted from one. Export also
 *    skips the top-level debug/ folder and atomic-write temp leftovers.
 *
 * importArchive never opens a credential file: credential-like files of the
 * old data dir (and any `carry` paths, such as an LH_AUTH_FILE that lives
 * inside the data dir) move into the new data dir by rename, so secrets stay
 * with this server and do not go into the backup.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const TEMP_LEFTOVER = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every refusal of this module. `code` is stable for callers and tests. */
export class DataArchiveError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.name = "DataArchiveError";
		this.code = code;
	}
}

/** True for a file name that can hold secrets (checked on the base name).
 * @param {string} name */
export function isCredentialName(name) {
	const base = name.split("/").pop() ?? name;
	return /^auth\.json/i.test(base) || /-credentials\.json/i.test(base) || /^\.env/i.test(base);
}

/** True when export leaves the relative path out (no error).
 * @param {string} rel posix relative path */
function skippedOnExport(rel) {
	return rel === "debug" || rel.startsWith("debug/") || isCredentialName(rel) || TEMP_LEFTOVER.test(rel);
}

/** Refuse a name that is not a plain relative path.
 * @param {string} rel posix relative path, no trailing slash */
function checkName(rel) {
	if (!rel) throw new DataArchiveError("bad_name", "Empty entry name");
	if (rel.includes("\0") || rel.includes("\\")) throw new DataArchiveError("bad_name", `Refused entry name: ${JSON.stringify(rel)}`);
	if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) throw new DataArchiveError("absolute_path", `Refused absolute entry: ${rel}`);
	for (const segment of rel.split("/")) {
		if (segment === "..") throw new DataArchiveError("path_traversal", `Refused entry outside the target: ${rel}`);
		if (segment === "" || segment === ".") throw new DataArchiveError("bad_name", `Refused entry name: ${rel}`);
	}
}

/** Split a name into ustar prefix + name, or refuse it.
 * @param {string} rel @returns {{ name: Buffer, prefix: Buffer }} */
function splitName(rel) {
	const whole = Buffer.from(rel, "utf8");
	if (whole.length <= NAME_MAX) return { name: whole, prefix: Buffer.alloc(0) };
	for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) {
		const prefix = Buffer.from(rel.slice(0, i), "utf8");
		const name = Buffer.from(rel.slice(i + 1), "utf8");
		if (prefix.length <= PREFIX_MAX && name.length <= NAME_MAX && name.length > 0) return { name, prefix };
	}
	throw new DataArchiveError("name_too_long", `Name does not fit ustar: ${rel}`);
}

/** @param {Buffer} block @param {number} offset @param {number} width @param {number} value */
function writeOctal(block, offset, width, value) {
	const digits = Math.floor(value).toString(8);
	if (digits.length > width - 1) throw new DataArchiveError("too_large", "Value does not fit ustar");
	block.write(digits.padStart(width - 1, "0"), offset, "ascii");
	block[offset + width - 1] = 0;
}

/** @param {string} rel @param {"0" | "5"} type @param {number} size @param {number} mtimeMs */
function header(rel, type, size, mtimeMs) {
	const block = Buffer.alloc(BLOCK);
	const { name, prefix } = splitName(type === "5" ? `${rel}/` : rel);
	name.copy(block, 0);
	writeOctal(block, 100, 8, type === "5" ? 0o755 : 0o644);
	writeOctal(block, 108, 8, 0);
	writeOctal(block, 116, 8, 0);
	writeOctal(block, 124, 12, size);
	writeOctal(block, 136, 12, Math.max(0, mtimeMs / 1000));
	block.write("        ", 148, "ascii"); // checksum field counts as spaces
	block.write(type, 156, "ascii");
	block.write("ustar\0", 257, "ascii");
	block.write("00", 263, "ascii");
	prefix.copy(block, 345);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
	block[154] = 0;
	block[155] = 0x20;
	return block;
}

/**
 * The tar.gz of `dataDir`: sorted, regular files and directories only.
 * Throws DataArchiveError on a symlink or special file, a name that does not
 * fit ustar, or more than `maxBytes` of tar stream.
 * @param {string} dataDir
 * @param {{ maxBytes?: number }} [options]
 * @returns {Buffer}
 */
export function createArchive(dataDir, options = {}) {
	const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
	const root = path.resolve(dataDir);
	if (!fs.statSync(root).isDirectory()) throw new DataArchiveError("not_directory", `${root} is not a directory`);
	/** @type {Buffer[]} */
	const parts = [];
	let total = 2 * BLOCK; // the end-of-archive blocks
	/** @param {number} bytes */
	const reserve = (bytes) => {
		total += bytes;
		if (total > maxBytes) throw new DataArchiveError("too_large", `Archive is larger than ${maxBytes} bytes`);
	};
	/** @param {string} dirRel */
	const walk = (dirRel) => {
		const names = fs.readdirSync(path.join(root, dirRel)).sort();
		for (const entryName of names) {
			const rel = dirRel ? `${dirRel}/${entryName}` : entryName;
			if (skippedOnExport(rel)) continue;
			checkName(rel);
			const abs = path.join(root, rel);
			const stat = fs.lstatSync(abs);
			if (stat.isSymbolicLink()) throw new DataArchiveError("symlink", `Refused symlink: ${rel}`);
			if (stat.isDirectory()) {
				reserve(BLOCK);
				parts.push(header(rel, "5", 0, stat.mtimeMs));
				walk(rel);
			} else if (stat.isFile()) {
				const padded = Math.ceil(stat.size / BLOCK) * BLOCK;
				reserve(BLOCK + padded);
				const data = fs.readFileSync(abs);
				if (data.length !== stat.size) throw new DataArchiveError("changed", `File changed during export: ${rel}`);
				parts.push(header(rel, "0", data.length, stat.mtimeMs), data, Buffer.alloc(padded - data.length));
			} else {
				throw new DataArchiveError("special_file", `Refused special file: ${rel}`);
			}
		}
	};
	walk("");
	parts.push(Buffer.alloc(2 * BLOCK));
	return zlib.gzipSync(Buffer.concat(parts));
}

/** @param {Buffer} block @param {number} offset @param {number} width */
function readString(block, offset, width) {
	const field = block.subarray(offset, offset + width);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? width : end).toString("utf8");
}

/** @param {Buffer} block @param {number} offset @param {number} width */
function readOctal(block, offset, width) {
	if (block[offset] !== undefined && block[offset] & 0x80) throw new DataArchiveError("bad_header", "Base-256 sizes are not supported");
	const text = readString(block, offset, width).trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw new DataArchiveError("bad_header", "Corrupt tar header");
	return parseInt(text, 8);
}

/**
 * Parse the archive into entries without touching the disk.
 * @param {Buffer} buffer tar.gz bytes
 * @param {number} maxBytes
 * @returns {{ rel: string, type: "file" | "dir", data: Buffer, mtime: number }[]}
 */
function readEntries(buffer, maxBytes) {
	let tar;
	try {
		tar = zlib.gunzipSync(buffer, { maxOutputLength: maxBytes });
	} catch (error) {
		const code = /** @type {NodeJS.ErrnoException} */ (error).code;
		if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new DataArchiveError("too_large", `Archive is larger than ${maxBytes} bytes`);
		// A cut gzip stream (no CRC trailer) is Z_BUF_ERROR "unexpected end of file".
		if (code === "Z_BUF_ERROR" && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) throw new DataArchiveError("truncated", "The archive is incomplete (the gzip stream ends early)");
		throw new DataArchiveError("bad_gzip", "The file is not a gzip archive");
	}
	/** @type {{ rel: string, type: "file" | "dir", data: Buffer, mtime: number }[]} */
	const entries = [];
	for (let offset = 0; ; ) {
		if (offset + BLOCK > tar.length) throw new DataArchiveError("truncated", "Archive ends without the end-of-archive blocks");
		const block = tar.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) break;
		let sum = 0;
		for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : /** @type {number} */ (block[i]);
		if (readOctal(block, 148, 8) !== sum) throw new DataArchiveError("bad_header", "Tar header checksum mismatch");
		if (!readString(block, 257, 6).startsWith("ustar")) throw new DataArchiveError("bad_header", "Not a ustar archive");
		const prefix = readString(block, 345, PREFIX_MAX);
		const rawName = readString(block, 0, NAME_MAX);
		const full = prefix ? `${prefix}/${rawName}` : rawName;
		const flag = String.fromCharCode(/** @type {number} */ (block[156]));
		const size = readOctal(block, 124, 12);
		const mtime = readOctal(block, 136, 12);
		offset += BLOCK;
		/** @type {"file" | "dir"} */
		let type;
		if (flag === "0" || flag === "\0") type = full.endsWith("/") ? "dir" : "file";
		else if (flag === "5") type = "dir";
		else if (flag === "1" || flag === "2") throw new DataArchiveError("link", `Refused link entry: ${full}`);
		else if (flag === "3" || flag === "4" || flag === "6") throw new DataArchiveError("special_file", `Refused device or FIFO entry: ${full}`);
		else throw new DataArchiveError("unsupported_entry", `Refused tar entry type ${JSON.stringify(flag)}: ${full}`);
		const rel = full.replace(/\/+$/, "");
		checkName(rel);
		if (type === "dir" && size !== 0) throw new DataArchiveError("bad_header", `Directory with data: ${rel}`);
		if (offset + size > tar.length) throw new DataArchiveError("truncated", `Archive ends inside ${rel}`);
		entries.push({ rel, type, data: tar.subarray(offset, offset + size), mtime });
		offset += Math.ceil(size / BLOCK) * BLOCK;
	}
	return entries;
}

/**
 * Write the archive's entries into `targetDir`, which must not exist or be
 * empty. Credential-like entries are skipped (never written). Throws
 * DataArchiveError on any refused entry BEFORE writing anything.
 * @param {Buffer} buffer tar.gz bytes
 * @param {string} targetDir
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ files: number, dirs: number, skipped: string[] }}
 */
export function extractArchive(buffer, targetDir, options = {}) {
	const entries = readEntries(buffer, options.maxBytes ?? MAX_ARCHIVE_BYTES);
	const root = path.resolve(targetDir);
	fs.mkdirSync(root, { recursive: true });
	if (fs.readdirSync(root).length > 0) throw new DataArchiveError("target_not_empty", `${root} is not empty`);
	let files = 0;
	let dirs = 0;
	/** @type {string[]} */
	const skipped = [];
	for (const entry of entries) {
		if (isCredentialName(entry.rel)) {
			skipped.push(entry.rel);
			continue;
		}
		const abs = path.resolve(root, ...entry.rel.split("/"));
		if (!abs.startsWith(root + path.sep)) throw new DataArchiveError("path_traversal", `Refused entry outside the target: ${entry.rel}`);
		if (entry.type === "dir") {
			fs.mkdirSync(abs, { recursive: true });
			dirs++;
			continue;
		}
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, entry.data, { flag: "wx" }); // a duplicate entry fails, never overwrites
		if (entry.mtime > 0) fs.utimesSync(abs, entry.mtime, entry.mtime);
		files++;
	}
	return { files, dirs, skipped };
}

/**
 * Check an extracted data dir: every chats/*.json must parse as JSON.
 * @param {string} dir
 * @returns {{ chats: number }}
 */
export function checkDataDir(dir) {
	const chatsDir = path.join(dir, "chats");
	let names = [];
	try {
		names = fs.readdirSync(chatsDir).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
	}
	for (const name of names) {
		try {
			JSON.parse(fs.readFileSync(path.join(chatsDir, name), "utf8"));
		} catch {
			throw new DataArchiveError("bad_chat", `chats/${name} is not valid JSON`);
		}
	}
	return { chats: names.length };
}

/** Number of chats/*.json files in a data dir (0 when absent).
 * @param {string} dataDir */
export function countChats(dataDir) {
	try {
		return fs.readdirSync(path.join(dataDir, "chats")).filter((name) => name.endsWith(".json")).length;
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return 0;
		throw error;
	}
}

/** Relative paths of credential-like files inside `dir` (lstat walk, no reads).
 * @param {string} dir @param {string} [rel] @returns {string[]} */
function credentialFiles(dir, rel = "") {
	/** @type {string[]} */
	const found = [];
	for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const child = rel ? path.join(rel, entry.name) : entry.name;
		if (isCredentialName(entry.name) && !entry.isDirectory()) found.push(child);
		else if (entry.isDirectory()) found.push(...credentialFiles(dir, child));
	}
	return found;
}

/** A timestamp safe for folder names on every platform. */
function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Replace `dataDir` with the archive's contents:
 *  1. extract into a staging dir beside the data dir and check it;
 *  2. move credential-like files (and `carry` paths inside the data dir)
 *     from the old data dir into staging, by rename only;
 *  3. rename the old data dir to `<parent>/backups/<timestamp>/`;
 *  4. rename staging to the data dir.
 * Any failure rolls the renames back and removes staging.
 * @param {Buffer} buffer tar.gz bytes
 * @param {string} dataDir
 * @param {{ carry?: string[], maxBytes?: number }} [options]
 * @returns {{ files: number, chats: number, backup: string | null, skipped: string[] }}
 */
export function importArchive(buffer, dataDir, options = {}) {
	const target = path.resolve(dataDir);
	const parent = path.dirname(target);
	fs.mkdirSync(parent, { recursive: true });
	const staging = path.join(parent, `.${path.basename(target)}-import-${randomUUID()}`);
	/** @type {{ from: string, to: string }[]} */
	const moved = [];
	let backup = null;
	let swapped = false;
	try {
		const { files, skipped } = extractArchive(buffer, staging, options);
		const { chats } = checkDataDir(staging);
		if (fs.existsSync(target)) {
			const carry = new Set(credentialFiles(target));
			for (const extra of options.carry ?? []) {
				const rel = path.relative(target, path.resolve(extra));
				if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.lstatSync(path.join(target, rel), { throwIfNoEntry: false })) carry.add(rel);
			}
			for (const rel of carry) {
				const to = path.join(staging, rel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.rmSync(to, { recursive: true, force: true }); // the server's own secret wins over the archive's path
				fs.renameSync(path.join(target, rel), to);
				moved.push({ from: path.join(target, rel), to });
			}
			const backups = path.join(parent, "backups");
			fs.mkdirSync(backups, { recursive: true });
			backup = path.join(backups, stamp());
			while (fs.existsSync(backup)) backup = path.join(backups, `${stamp()}-${randomUUID().slice(0, 8)}`);
			fs.renameSync(target, backup);
		}
		try {
			fs.renameSync(staging, target);
		} catch (error) {
			if (backup) fs.renameSync(backup, target);
			backup = null;
			throw error;
		}
		swapped = true;
		return { files, chats, backup, skipped };
	} finally {
		if (!swapped) {
			let restored = true;
			for (const { from, to } of moved.reverse()) {
				try {
					fs.mkdirSync(path.dirname(from), { recursive: true });
					fs.renameSync(to, from);
				} catch (error) {
					restored = false;
					console.error(`[data-archive] could not move ${to} back to ${from}:`, error);
				}
			}
			// Never delete staging while it still holds a secret we moved in.
			if (restored) fs.rmSync(staging, { recursive: true, force: true });
			else console.error(`[data-archive] kept ${staging}: it still holds moved credential files`);
		}
	}
}
