/**
 * Fork: desktop remote server mode. The service token goes only to the
 * remote origin, is stored only through a strong OS keyring, and the server
 * probe tells a token problem from a network problem.
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
const { remoteAccessHeaders, probeServer } = require("../electron/remote-headers.cjs");
const profile = require("../electron/server-profile.cjs");

const creds = { clientId: "abcdef0123456789.access", clientSecret: "s3cret-value" };
const origin = "https://learn.example.com";

function fakeSafeStorage(backend = "gnome_libsecret") {
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => backend,
		encryptString: (value: string) => Buffer.from(`enc:${value}`),
		decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
	};
}

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-remote-desktop-"));
}

describe("service token headers", () => {
	it("adds the token only for the exact remote origin", () => {
		const added = remoteAccessHeaders({ url: `${origin}/api/chats`, requestHeaders: { Accept: "*/*" } }, origin, creds);
		assert.equal(added["CF-Access-Client-Id"], creds.clientId);
		assert.equal(added["CF-Access-Client-Secret"], creds.clientSecret);
		for (const url of ["https://evil.example/api", "http://learn.example.com/api", "https://learn.example.com:8443/", "https://user:pw@learn.example.com/", "not a url"]) {
			const headers = remoteAccessHeaders({ url, requestHeaders: {} }, origin, creds);
			assert.equal(headers["CF-Access-Client-Secret"], undefined, url);
		}
	});

	it("strips any token a page or redirect tries to send elsewhere", () => {
		const headers = remoteAccessHeaders({ url: "https://evil.example/", requestHeaders: { "cf-access-client-id": "x", "CF-ACCESS-CLIENT-SECRET": "y", Keep: "1" } }, origin, creds);
		assert.deepEqual(headers, { Keep: "1" });
	});
});

describe("server profile", () => {
	it("defaults to local and survives a broken file", () => {
		const dir = tempDir();
		assert.deepEqual(profile.loadProfile(dir), { mode: "local" });
		fs.writeFileSync(path.join(dir, "server-profile.json"), "{broken");
		assert.deepEqual(profile.loadProfile(dir), { mode: "local" });
	});

	it("stores the secret only as ciphertext, with mode 600, and never returns it", () => {
		const dir = tempDir();
		const saved = profile.saveProfile(dir, { mode: "remote", url: "https://learn.example.com/", clientId: creds.clientId, secret: creds.clientSecret }, fakeSafeStorage());
		assert.deepEqual(saved, { mode: "remote", url: origin, clientId: creds.clientId, hasSecret: true });
		const file = path.join(dir, "server-profile.json");
		const raw = fs.readFileSync(file, "utf8");
		assert.ok(!raw.includes(creds.clientSecret));
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(profile.remoteCredentials(profile.loadProfile(dir), fakeSafeStorage()), { url: origin, ...creds });
	});

	it("keeps the stored secret when the form leaves it empty", () => {
		const dir = tempDir();
		profile.saveProfile(dir, { mode: "remote", url: origin, clientId: creds.clientId, secret: creds.clientSecret }, fakeSafeStorage());
		profile.saveProfile(dir, { mode: "local", url: origin, clientId: creds.clientId, secret: "" }, fakeSafeStorage());
		const local = profile.loadProfile(dir);
		assert.equal(local.mode, "local");
		assert.ok(local.secretCipher);
	});

	it("refuses a plaintext keyring, plain http, a path, and remote mode without a secret", () => {
		const dir = tempDir();
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: origin, clientId: creds.clientId, secret: "x" }, fakeSafeStorage("basic_text")), /keyring/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: "http://learn.example.com", clientId: creds.clientId, secret: "x" }, fakeSafeStorage()), /https/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: `${origin}/app`, clientId: creds.clientId, secret: "x" }, fakeSafeStorage()), /no path/);
		assert.throws(() => profile.saveProfile(dir, { mode: "remote", url: origin, clientId: creds.clientId }, fakeSafeStorage()), /client secret/);
		assert.equal(profile.normalizeServerURL("http://localhost:3000"), "http://localhost:3000");
	});

	it("imports the setup token file once, keeps the mode, and deletes the plaintext", () => {
		const dir = tempDir();
		const file = path.join(dir, "service-token.json");
		fs.writeFileSync(file, JSON.stringify({ url: origin, ...creds }));
		assert.equal(profile.importTokenFile(dir, file, fakeSafeStorage()), true);
		assert.equal(fs.existsSync(file), false);
		const loaded = profile.loadProfile(dir);
		assert.equal(loaded.mode, "local");
		assert.equal(profile.publicProfile(loaded).hasSecret, true);
		assert.equal(profile.importTokenFile(dir, file, fakeSafeStorage()), false);
	});
});

describe("server probe", () => {
	async function serve(handler: Parameters<typeof createServer>[1], run: (url: string) => Promise<void>) {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
		finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
	}

	it("sends the token and accepts a LearnHarness health answer", async () => {
		let seen: string | undefined;
		await serve((req, res) => { seen = req.headers["cf-access-client-secret"] as string; res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }, async (url) => {
			assert.deepEqual(await probeServer(url, creds), { ok: true });
			assert.equal(seen, creds.clientSecret);
		});
	});

	it("reports an Access login redirect or 403 as a token problem", async () => {
		await serve((_req, res) => { res.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }); res.end(); }, async (url) => {
			assert.equal((await probeServer(url, creds)).reason, "auth");
		});
		await serve((_req, res) => { res.writeHead(403); res.end(); }, async (url) => {
			assert.equal((await probeServer(url, creds)).reason, "auth");
		});
	});

	it("reports another app and a closed port", async () => {
		await serve((_req, res) => { res.end("<html>hello</html>"); }, async (url) => {
			assert.equal((await probeServer(url, creds)).reason, "not-learnharness");
		});
		assert.equal((await probeServer("http://127.0.0.1:9", creds, { timeoutMs: 2000 })).reason, "network");
	});
});
