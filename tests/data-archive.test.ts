import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { after, it } from "node:test";
import { createArchive, extractArchive, importArchive, DataArchiveError } from "../src/server/data-archive.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-archive-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string) => path.join(root, `${label}-${n++}`);

function write(dir: string, rel: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
}

/** Every file under dir as rel → content (posix rel paths). */
function tree(dir: string, rel = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const child = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, tree(dir, child));
		else out[child] = fs.readFileSync(path.join(dir, child), "utf8");
	}
	return out;
}

/** A hand-made ustar archive, to feed the reader entries the writer never makes. */
function rawTar(entries: { name: string; type?: string; data?: string; linkname?: string }[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const block = Buffer.alloc(512);
		block.write(entry.name, 0, "utf8");
		block.write("0000644\0", 100, "ascii");
		block.write("0000000\0", 108, "ascii");
		block.write("0000000\0", 116, "ascii");
		block.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		block.write("00000000000\0", 136, "ascii");
		block.write("        ", 148, "ascii");
		block.write(entry.type ?? "0", 156, "ascii");
		if (entry.linkname) block.write(entry.linkname, 157, "utf8");
		block.write("ustar\0" + "00", 257, "ascii");
		let sum = 0;
		for (const byte of block) sum += byte;
		block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
		parts.push(block, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
	}
	parts.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(parts));
}

function refusedWith(code: string) {
	return (error: unknown) => error instanceof DataArchiveError && error.code === code;
}

it("round-trips files, nested folders, empty folders and long names", () => {
	const src = fresh("src");
	write(src, "chats/a.json", JSON.stringify({ id: "a", messages: [] }));
	write(src, "graph/nodes.jsonl", "{\"id\":\"n\"}\n");
	write(src, "settings.json", "{}");
	write(src, "plugins/x/data/ünïcode.txt", "héllo");
	const longRel = `prompts/${"d".repeat(90)}/${"f".repeat(90)}.md`;
	write(src, longRel, "long");
	fs.mkdirSync(path.join(src, "jobs"));
	const archive = createArchive(src);
	assert.equal(archive[0], 0x1f, "gzip magic");
	const out = fresh("out");
	const result = extractArchive(archive, out);
	assert.equal(result.files, 5);
	assert.deepEqual(tree(out), tree(src));
	assert.ok(fs.statSync(path.join(out, "jobs")).isDirectory(), "empty folders survive");
	assert.deepEqual(createArchive(out), createArchive(out), "deterministic for the same tree");
});

it("interoperates with the system tar in both directions", { skip: spawnSync("tar", ["--version"]).status !== 0 }, () => {
	const src = fresh("src");
	write(src, "chats/a.json", "{}");
	write(src, `prompts/${"d".repeat(90)}/${"f".repeat(90)}.md`, "long");
	const file = path.join(fresh("file"), "x.tar.gz");
	fs.mkdirSync(path.dirname(file));
	fs.writeFileSync(file, createArchive(src));
	const out = fresh("sys");
	fs.mkdirSync(out);
	assert.equal(spawnSync("tar", ["-xzf", file, "-C", out]).status, 0);
	assert.deepEqual(tree(out), tree(src));
	const made = path.join(fresh("file"), "y.tar.gz");
	fs.mkdirSync(path.dirname(made));
	assert.equal(spawnSync("tar", ["--format=ustar", "-czf", made, "-C", src, "chats", "prompts"]).status, 0);
	const back = fresh("back");
	extractArchive(fs.readFileSync(made), back);
	assert.deepEqual(tree(back), tree(src));
});

it("skips debug/, credential-like files and atomic-write leftovers on export", () => {
	const src = fresh("src");
	write(src, "chats/a.json", "{}");
	write(src, "auth.json", "{\"KEY\":\"secret\"}");
	write(src, "auth.json.bak", "secret");
	write(src, "chatgpt-credentials.json", "secret");
	write(src, "nested/claude-credentials.json.tmp-x", "secret");
	write(src, ".env.local", "KEY=secret");
	write(src, "debug/provider-events/a.jsonl", "noise");
	write(src, "settings.json.tmp-0b6a5f8e-3a39-4f39-9a52-3f6a3b0c7d11", "{}");
	const out = fresh("out");
	extractArchive(createArchive(src), out);
	assert.deepEqual(Object.keys(tree(out)), ["chats/a.json"]);
	assert.equal(fs.existsSync(path.join(out, "debug")), false);
});

it("never extracts credential-like entries from an archive", () => {
	const out = fresh("out");
	const result = extractArchive(rawTar([{ name: "auth.json", data: "{}" }, { name: "x/.env", data: "A=1" }, { name: "ok.txt", data: "ok" }]), out);
	assert.deepEqual(result.skipped, ["auth.json", "x/.env"]);
	assert.deepEqual(Object.keys(tree(out)), ["ok.txt"]);
});

it("refuses traversal and absolute names before writing anything", () => {
	for (const [name, code] of [["../evil.txt", "path_traversal"], ["chats/../../evil.txt", "path_traversal"], ["/etc/evil", "absolute_path"], ["C:/evil", "absolute_path"], ["a\\..\\evil", "bad_name"]] as const) {
		const out = fresh("out");
		assert.throws(() => extractArchive(rawTar([{ name: "first.txt", data: "x" }, { name, data: "evil" }]), out), refusedWith(code), name);
		assert.equal(fs.existsSync(out), false, `${name}: nothing written, not even the target`);
	}
	assert.equal(fs.existsSync(path.join(root, "evil.txt")), false);
});

it("refuses symlinks on export and link/device entries on extract", () => {
	const src = fresh("src");
	write(src, "chats/a.json", "{}");
	fs.symlinkSync("/etc/passwd", path.join(src, "chats", "link.json"));
	assert.throws(() => createArchive(src), refusedWith("symlink"));
	assert.throws(() => extractArchive(rawTar([{ name: "s", type: "2", linkname: "/etc/passwd" }]), fresh("out")), refusedWith("link"));
	assert.throws(() => extractArchive(rawTar([{ name: "h", type: "1", linkname: "chats/a.json" }]), fresh("out")), refusedWith("link"));
	assert.throws(() => extractArchive(rawTar([{ name: "dev", type: "3" }]), fresh("out")), refusedWith("special_file"));
	assert.throws(() => extractArchive(rawTar([{ name: "pax", type: "x", data: "30 path=../../evil\n" }]), fresh("out")), refusedWith("unsupported_entry"));
});

it("refuses archives past the size cap in both directions, gzip bombs included", () => {
	const src = fresh("src");
	write(src, "big.txt", "x".repeat(64 * 1024));
	assert.throws(() => createArchive(src, { maxBytes: 32 * 1024 }), refusedWith("too_large"));
	const archive = createArchive(src);
	assert.ok(archive.length < 32 * 1024, "compresses well: the cap is on the tar stream");
	assert.throws(() => extractArchive(archive, fresh("out"), { maxBytes: 32 * 1024 }), refusedWith("too_large"));
	assert.throws(() => extractArchive(Buffer.from("not gzip"), fresh("out")), refusedWith("bad_gzip"));
});

it("refuses names that do not fit ustar and a non-empty target", () => {
	const src = fresh("src");
	write(src, `${"n".repeat(120)}.txt`, "x");
	assert.throws(() => createArchive(src), refusedWith("name_too_long"));
	const out = fresh("out");
	write(out, "keep.txt", "keep");
	assert.throws(() => extractArchive(rawTar([{ name: "a.txt", data: "a" }]), out), refusedWith("target_not_empty"));
});

it("importArchive backs up the old dir and keeps its secrets in place by rename", () => {
	const base = fresh("server");
	const data = path.join(base, "data");
	write(data, "chats/old.json", "{}");
	write(data, "auth.json", "{\"KEY\":\"server\"}");
	write(data, "custom/keys.json", "server-only");
	const src = fresh("src");
	write(src, "chats/new.json", "{\"id\":\"new\"}");
	const result = importArchive(createArchive(src), data, { carry: [path.join(data, "custom/keys.json")] });
	assert.equal(result.chats, 1);
	assert.ok(result.backup?.startsWith(path.join(base, "backups") + path.sep));
	assert.deepEqual(tree(data), { "auth.json": "{\"KEY\":\"server\"}", "chats/new.json": "{\"id\":\"new\"}", "custom/keys.json": "server-only" });
	assert.deepEqual(tree(result.backup!), { "chats/old.json": "{}" }, "secrets do not go into the backup");
	assert.deepEqual(fs.readdirSync(base).sort(), ["backups", "data"], "no staging left over");
});

it("importArchive leaves the old dir untouched when a chat does not parse", () => {
	const base = fresh("server");
	const data = path.join(base, "data");
	write(data, "chats/old.json", "{}");
	write(data, "auth.json", "{}");
	assert.throws(() => importArchive(rawTar([{ name: "chats/bad.json", data: "{nope" }]), data), refusedWith("bad_chat"));
	assert.deepEqual(tree(data), { "auth.json": "{}", "chats/old.json": "{}" });
	assert.deepEqual(fs.readdirSync(base), ["data"]);
});
