/**
 * Fork: desktop remote server mode (Tailscale variant). The profile holds only
 * the mode and the server address (no secret), and the server probe tells a
 * Tailscale identity problem from a network problem.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { probeServer } = require("../electron/server-probe.cjs");
const profile = require("../electron/server-profile.cjs");

const origin = "https://learnharness.tail1234.ts.net";

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-remote-desktop-"));
}

describe("server profile", () => {
	it("defaults to local and survives a broken file", () => {
		const dir = tempDir();
		assert.deepEqual(profile.loadProfile(dir), { mode: "local" });
		fs.writeFileSync(path.join(dir, "server-profile.json"), "{broken");
		assert.deepEqual(profile.loadProfile(dir), { mode: "local" });
	});

	it("stores the mode and the origin only, with mode 600", () => {
		const dir = tempDir();
		const saved = profile.saveProfile(dir, { mode: "remote", url: `${origin}/`, secret: "ignored" });
		assert.deepEqual(saved, { mode: "remote", url: origin });
		const file = path.join(dir, "server-profile.json");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "remote", url: origin });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(profile.remoteServerFromProfile(profile.loadProfile(dir)), { url: origin });
	});

	it("keeps the address when switching to local, and drops fields of the Cloudflare variant", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "server-profile.json"), JSON.stringify({ mode: "remote", url: origin, clientId: "old.access", secretCipher: "b2xk" }));
		assert.deepEqual(profile.loadProfile(dir), { mode: "remote", url: origin });
		profile.saveProfile(dir, { mode: "local", url: "" });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "server-profile.json"), "utf8")), { mode: "local", url: origin });
		assert.deepEqual(profile.remoteServerFromProfile(profile.loadProfile(dir)), { error: "Not in server mode." });
	});

	it("refuses plain http, a path, credentials and remote mode without an address", () => {
		const dir = tempDir();
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: "http://learnharness.tail1234.ts.net" }), /https/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: `${origin}/app` }), /no path/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: "https://u:p@learnharness.tail1234.ts.net" }), /user name/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote" }), /server address/);
		assert.equal(profile.normalizeServerURL("http://localhost:3000"), "http://localhost:3000");
	});
});

describe("server probe", () => {
	async function serve(handler: Parameters<typeof createServer>[1], run: (url: string) => Promise<void>) {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
		finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
	}
	const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	it("sends no credentials and reports the accepted login", async () => {
		const seen: Record<string, string | undefined>[] = [];
		await serve((req, res) => {
			seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
			if (req.url === "/api/health") json(res, 200, { ok: true });
			else json(res, 200, { ok: true, remote: true, login: "learner@example.com" });
		}, async (url) => {
			assert.deepEqual(await probeServer(url), { ok: true, login: "learner@example.com" });
		});
		assert.deepEqual(seen, [
			{ path: "/api/health", authorization: undefined, cookie: undefined },
			{ path: "/api/whoami", authorization: undefined, cookie: undefined },
		]);
	});

	it("reports a refused identity as an auth problem, with the server's reason", async () => {
		await serve((req, res) => {
			if (req.url === "/api/health") json(res, 200, { ok: true });
			else json(res, 403, { error: "The Tailscale user someone@example.com may not use this server." });
		}, async (url) => {
			const result = await probeServer(url);
			assert.equal(result.reason, "auth");
			assert.match(result.message, /someone@example\.com/);
		});
	});

	it("reports another app, an HTTP error and a closed port", async () => {
		await serve((_req, res) => { res.end("<html>hello</html>"); }, async (url) => {
			assert.equal((await probeServer(url)).reason, "not-learnharness");
		});
		await serve((_req, res) => { res.writeHead(502); res.end(); }, async (url) => {
			assert.equal((await probeServer(url)).reason, "http");
		});
		const closed = await probeServer("http://127.0.0.1:9", { timeoutMs: 2000 });
		assert.equal(closed.reason, "network");
		assert.match(closed.message, /Tailscale/);
	});
});
