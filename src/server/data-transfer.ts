/**
 * Data export/import over HTTP (remote-server plan, phase 4). The routes
 * app/api/data/export and app/api/data/import are thin wrappers over these
 * two responses; the archive format and the swap live in data-archive.mjs
 * (shared with scripts/data-archive.mjs).
 *
 *   GET  /api/data/export          → 200 tar.gz attachment of PATHS.data
 *   POST /api/data/import[?replace=1] (body: the tar.gz, raw or as the
 *        multipart field "file") → 200 {ok, files, chats, backup, skipped}
 *
 * Refusals: 409 turn_running (any chat has a turn in flight), 409
 * transfer_running (another import is in progress), 409 server_has_data
 * (the server has chats and replace=1 is absent), 413 too_large, 400 for an
 * archive the module refuses (400 truncated for a cut upload). Size: the
 * route accepts 256 MB, but through Next's Proxy the EFFECTIVE limit is
 * experimental.proxyClientMaxBodySize (next.config.ts, 26 MiB); a larger
 * upload arrives cut and is refused, never partly imported. For larger data
 * dirs, run scripts/data-archive.mjs on the server. The auth file is never read or written: when
 * it (or a web-subscription credential file) sits inside the data dir, the
 * import moves it into the new data dir by rename.
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { FormBodyLimitError } from "../../lib/bounded-form-data.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { runningTurn } from "./turn-runs.ts";
import { createArchive, importArchive, countChats, DataArchiveError, MAX_ARCHIVE_BYTES } from "./data-archive.mjs";

interface LhDataTransferGlobal {
	__lhTurnRegistry?: Map<string, number>;
	__lhTurnRuns?: Map<string, unknown>;
	__lhDataImportBusy?: boolean;
}

const g = globalThis as typeof globalThis & LhDataTransferGlobal;

/** True while any chat has a turn in flight. Reads the two globalThis
 *  registries that turn-liveness.ts and turn-runs.ts own; isTurnRunning
 *  applies the stale-entry TTL. */
export function anyTurnRunning(): boolean {
	for (const chatId of g.__lhTurnRegistry?.keys() ?? []) if (isTurnRunning(chatId)) return true;
	for (const chatId of g.__lhTurnRuns?.keys() ?? []) if (runningTurn(chatId)) return true;
	return false;
}

function refusal(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
	return Response.json({ error, message, ...extra }, { status });
}

function archiveErrorResponse(error: unknown): Response {
	if (error instanceof DataArchiveError) return refusal(error.code === "too_large" ? 413 : 400, error.code, error.message);
	throw error;
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** GET /api/data/export. */
export function dataExportResponse(): Response {
	if (g.__lhDataImportBusy) return refusal(409, "transfer_running", "An import is in progress.");
	if (anyTurnRunning()) return refusal(409, "turn_running", "Wait for the running turn to finish, then export again.");
	let archive: Buffer;
	try {
		archive = createArchive(PATHS.data);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return refusal(404, "no_data", "The server has no data folder yet.");
		return archiveErrorResponse(error);
	}
	return new Response(new Uint8Array(archive), {
		headers: {
			"Content-Type": "application/gzip",
			"Content-Length": String(archive.length),
			"Content-Disposition": `attachment; filename="learnharness-data-${stamp()}.tar.gz"`,
			"Cache-Control": "no-store",
		},
	});
}

/** The request body as bytes, refused past maxBytes without trusting
 *  Content-Length. Multipart bodies give their "file" field.
 *
 *  Truncation: Next's Proxy (proxy.ts) clones the body and SILENTLY cuts it
 *  at experimental.proxyClientMaxBodySize (next.config.ts, 26 MiB). A body
 *  shorter than its Content-Length is refused here as "truncated"; without
 *  that header, the gzip reader refuses the cut stream (no CRC trailer) and
 *  a cut multipart body fails to parse. No partial tree is ever imported. */
async function readArchiveBody(request: Request, maxBytes: number): Promise<Buffer> {
	const multipart = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
	const limit = multipart ? maxBytes + 64 * 1024 : maxBytes;
	const declared = request.headers.get("content-length");
	if (Number(declared) > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new DataArchiveError("missing_file", "The request has no body.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new FormBodyLimitError();
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) !== bytes) {
		throw new DataArchiveError("truncated", `The upload arrived with ${bytes} of ${declared} bytes. Archives above the server's proxy body limit (26 MiB) are cut; use scripts/data-archive.mjs on the server instead.`);
	}
	const body = Buffer.concat(chunks, bytes);
	if (!multipart) return body;
	let form: FormData;
	try {
		form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} catch {
		throw new DataArchiveError("truncated", "The multipart upload is incomplete or malformed.");
	}
	const file = form.get("file");
	if (!(file instanceof Blob)) throw new DataArchiveError("missing_file", "The form has no \"file\" field.");
	if (file.size > maxBytes) throw new FormBodyLimitError();
	return Buffer.from(await file.arrayBuffer());
}

function chatIds(dataDir: string): string[] {
	try {
		return fs.readdirSync(path.join(dataDir, "chats")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
	} catch {
		return [];
	}
}

/** POST /api/data/import. `maxBytes` is for tests; the default is the
 *  archive module's cap (256 MB), applied to the compressed body and to
 *  the uncompressed tar stream. */
export async function dataImportResponse(request: Request, options: { maxBytes?: number } = {}): Promise<Response> {
	const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
	const replace = new URL(request.url).searchParams.get("replace") === "1";
	if (g.__lhDataImportBusy) return refusal(409, "transfer_running", "Another import is in progress.");
	if (anyTurnRunning()) return refusal(409, "turn_running", "Wait for the running turn to finish, then import again.");
	const existingChats = countChats(PATHS.data);
	if (existingChats > 0 && !replace) {
		return refusal(409, "server_has_data", `The server already has ${existingChats} chats. Send ?replace=1 to replace them (a backup is made first).`, { chats: existingChats });
	}
	g.__lhDataImportBusy = true;
	try {
		let archive: Buffer;
		try {
			archive = await readArchiveBody(request, maxBytes);
		} catch (error) {
			if (error instanceof FormBodyLimitError) return refusal(413, "too_large", `The archive is larger than ${maxBytes} bytes.`);
			if (error instanceof SyntaxError || error instanceof TypeError) return refusal(400, "bad_body", "The request body could not be read.");
			return archiveErrorResponse(error);
		}
		// Reading the body takes time: check again just before the swap.
		if (anyTurnRunning()) return refusal(409, "turn_running", "Wait for the running turn to finish, then import again.");
		const before = chatIds(PATHS.data);
		let result: ReturnType<typeof importArchive>;
		try {
			result = importArchive(archive, PATHS.data, { carry: [AUTH_FILE], maxBytes });
		} catch (error) {
			return archiveErrorResponse(error);
		}
		emit("chats-changed", {});
		emit("sources-changed", {});
		emit("jobs-changed", {});
		for (const chatId of new Set([...before, ...chatIds(PATHS.data)])) emit("record-changed", { chatId });
		return Response.json({ ok: true, files: result.files, chats: result.chats, backup: result.backup, skipped: result.skipped });
	} finally {
		g.__lhDataImportBusy = false;
	}
}
