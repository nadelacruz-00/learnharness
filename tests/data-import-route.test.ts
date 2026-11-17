import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { after, beforeEach, it } from "node:test";
import type { ServerEvent } from "../src/core/index.ts";

// Throwaway server layout, like scripts/smoke-server.mjs: <base>/data is
// LH_DATA_DIR; the auth file sits INSIDE it here to prove the import never
// loses or replaces it.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "lh-data-import-"));
const data = path.join(base, "data");
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(data, "auth.json");
const { GET } = await import("../app/api/data/export/route.ts");
const { POST } = await import("../app/api/data/import/route.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { subscribe } = await import("../src/core/events.ts");
const { createArchive } = await import("../src/server/data-archive.mjs");
after(() => fs.rmSync(base, { recursive: true, force: true }));

function write(dir: string, rel: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
}

beforeEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
	fs.mkdirSync(data, { recursive: true });
	write(data, "auth.json", "{\"KEY\":\"server-secret\"}");
});

/** The desktop's local data, as an uploaded archive. */
function localArchive(): Buffer {
	const local = fs.mkdtempSync(path.join(base, "..", "lh-local-"));
	try {
		write(local, "chats/c1.json", JSON.stringify({ id: "c1", messages: [] }));
		write(local, "chats/c2.json", JSON.stringify({ id: "c2", messages: [] }));
		write(local, "graph/nodes.jsonl", "{\"id\":\"n\"}\n");
		write(local, "settings.json", "{\"version\":1}");
		return createArchive(local);
	} finally {
		fs.rmSync(local, { recursive: true, force: true });
	}
}

const importRequest = (body: Buffer, query = "") => POST(new Request(`http://localhost/api/data/import${query}`, { method: "POST", body: new Uint8Array(body), headers: { "content-type": "application/gzip" } }));

it("imports into an empty server and announces the new records", async () => {
	const events: ServerEvent[] = [];
	const stop = subscribe((event) => events.push(event));
	try {
		const response = await importRequest(localArchive());
		assert.equal(response.status, 200);
		const result = await response.json() as { files: number; chats: number; backup: string | null };
		assert.equal(result.files, 4);
		assert.equal(result.chats, 2);
		assert.equal(typeof result.backup, "string", "the old (chat-less) data dir is still backed up");
		assert.deepEqual(fs.readdirSync(path.join(data, "chats")).sort(), ["c1.json", "c2.json"]);
		assert.equal(fs.readFileSync(path.join(data, "auth.json"), "utf8"), "{\"KEY\":\"server-secret\"}");
		const changed = events.filter((e) => e.type === "record-changed").map((e) => (e as { chatId: string }).chatId).sort();
		assert.deepEqual(changed, ["c1", "c2"]);
		assert.ok(events.some((e) => e.type === "chats-changed"));
	} finally {
		stop();
	}
});

it("refuses with 409 when the server has chats and replace=1 is absent", async () => {
	write(data, "chats/server.json", "{}");
	const response = await importRequest(localArchive());
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "server_has_data");
	assert.deepEqual(fs.readdirSync(path.join(data, "chats")), ["server.json"]);
	assert.deepEqual(fs.readdirSync(base), ["data"], "no staging or backup made");
});

it("replace=1 moves the old data to backups/<timestamp>/ and swaps the import in", async () => {
	write(data, "chats/server.json", "{\"id\":\"server\"}");
	write(data, "chatgpt-credentials.json", "{\"token\":\"server\"}");
	const response = await importRequest(localArchive(), "?replace=1");
	assert.equal(response.status, 200);
	const { backup, chats } = await response.json() as { backup: string; chats: number };
	assert.equal(chats, 2);
	assert.equal(path.dirname(backup), path.join(base, "backups"));
	assert.equal(fs.readFileSync(path.join(backup, "chats", "server.json"), "utf8"), "{\"id\":\"server\"}");
	assert.equal(fs.existsSync(path.join(data, "chats", "server.json")), false);
	// Secrets stay with the server, in the live data dir, not in the backup.
	assert.equal(fs.readFileSync(path.join(data, "auth.json"), "utf8"), "{\"KEY\":\"server-secret\"}");
	assert.equal(fs.readFileSync(path.join(data, "chatgpt-credentials.json"), "utf8"), "{\"token\":\"server\"}");
	assert.equal(fs.existsSync(path.join(backup, "auth.json")), false);
	assert.deepEqual(fs.readdirSync(base).sort(), ["backups", "data"], "no staging left over");
});

it("refuses import and export with 409 while a turn is running", async () => {
	write(data, "chats/c1.json", "{}");
	assert.equal(beginTurn("c1"), true);
	try {
		const imported = await importRequest(localArchive(), "?replace=1");
		assert.equal(imported.status, 409);
		assert.equal((await imported.json() as { error: string }).error, "turn_running");
		assert.equal((await GET()).status, 409);
		assert.deepEqual(fs.readdirSync(path.join(data, "chats")), ["c1.json"]);
	} finally {
		endTurn("c1");
	}
	assert.equal((await GET()).status, 200, "allowed again once the turn settles");
});

it("export returns a tar.gz attachment without credentials, and refuses a bad archive on import", async () => {
	write(data, "chats/c1.json", "{\"id\":\"c1\"}");
	write(data, "debug/provider-events/c1.jsonl", "noise");
	const response = await GET();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "application/gzip");
	assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="learnharness-data-.*\.tar\.gz"$/);
	const archive = Buffer.from(await response.arrayBuffer());
	const out = path.join(base, "check");
	(await import("../src/server/data-archive.mjs")).extractArchive(archive, out);
	assert.deepEqual(fs.readdirSync(out).sort(), ["chats"]);
	const bad = await importRequest(Buffer.from("not an archive"), "?replace=1");
	assert.equal(bad.status, 400);
	assert.equal(fs.readFileSync(path.join(data, "chats", "c1.json"), "utf8"), "{\"id\":\"c1\"}");
});

it("caps the request body", async () => {
	const { dataImportResponse } = await import("../src/server/data-transfer.ts");
	const response = await dataImportResponse(new Request("http://localhost/api/data/import", { method: "POST", body: new Uint8Array(4096) }), { maxBytes: 1024 });
	assert.equal(response.status, 413);
});

it("refuses a body that Next's Proxy cut short with 400 truncated, and leaves the data untouched", async () => {
	write(data, "chats/server.json", "{\"id\":\"server\"}");
	// Incompressible content, so the gzip is as long as the tar (like real
	// uploads above proxyClientMaxBodySize, 26 MiB, scaled down here).
	const local = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-big-"));
	let archive: Buffer;
	try {
		write(local, "chats/c1.json", JSON.stringify({ id: "c1", blob: randomBytes(256 * 1024).toString("base64") }));
		write(local, "plugins/x/big.bin", randomBytes(512 * 1024).toString("latin1"));
		archive = createArchive(local);
	} finally {
		fs.rmSync(local, { recursive: true, force: true });
	}
	const send = (body: Uint8Array, headers: Record<string, string>) => POST(new Request("http://localhost/api/data/import?replace=1", { method: "POST", body: new Uint8Array(body), headers }));
	for (const cut of [10, 512, 4096, Math.floor(archive.length / 2), archive.length - 8, archive.length - 1]) {
		const part = new Uint8Array(archive.subarray(0, cut));
		// The Proxy keeps the original Content-Length on the cut clone.
		const declared = await send(part, { "content-type": "application/gzip", "content-length": String(archive.length) });
		assert.equal(declared.status, 400, `cut at ${cut} with Content-Length`);
		const declaredBody = await declared.json() as { error: string; message: string };
		assert.equal(declaredBody.error, "truncated");
		assert.match(declaredBody.message, /26 MiB/);
		// Without a Content-Length, the gzip reader itself refuses the cut stream.
		const bare = await send(part, { "content-type": "application/gzip" });
		assert.equal(bare.status, 400, `cut at ${cut} without Content-Length`);
		assert.equal((await bare.json() as { error: string }).error, "truncated");
	}
	const form = new FormData();
	form.append("file", new File([new Uint8Array(archive)], "data.tar.gz", { type: "application/gzip" }));
	const whole = new Request("http://localhost/", { method: "POST", body: form });
	const multipart = new Uint8Array(await whole.arrayBuffer());
	const cutForm = await send(multipart.subarray(0, multipart.length - 100), { "content-type": whole.headers.get("content-type")! });
	assert.equal(cutForm.status, 400);
	assert.equal((await cutForm.json() as { error: string }).error, "truncated");
	assert.deepEqual(fs.readdirSync(path.join(data, "chats")), ["server.json"], "no partial tree imported");
	assert.deepEqual(fs.readdirSync(base), ["data"], "no staging or backup made");
	// The same multipart body, whole, imports.
	const ok = await send(multipart, { "content-type": whole.headers.get("content-type")! });
	assert.equal(ok.status, 200);
	assert.deepEqual(fs.readdirSync(path.join(data, "chats")), ["c1.json"]);
});
