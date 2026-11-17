/**
 * Remote server mode (fork): every request must carry a valid Cloudflare
 * Access JWT. Pages are gated as well as the API. Local modes are unchanged.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { browserHostAllowed, subscriptionRequestOrigin } from "../src/server/desktop-access.ts";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";
import { remoteAccessConfig, remoteAccessRefusal, resetRemoteAccessCache } from "../src/server/remote-access.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-for-learnharness";
const PUBLIC = "https://learn.example.com";

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let good: Keys, other: Keys, jwks: JWTVerifyGetKey, publicJWK: JWK;
let server: Server, certsUrl: string;

before(async () => {
	good = await generateKeyPair("RS256");
	other = await generateKeyPair("RS256");
	publicJWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
	jwks = createLocalJWKSet({ keys: [publicJWK] });
	server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ keys: [publicJWK] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	certsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function remoteEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		LH_SERVER_MODE: "remote",
		LH_CF_ACCESS_TEAM_DOMAIN: TEAM,
		LH_CF_ACCESS_AUD: AUD,
		LH_PUBLIC_ORIGIN: PUBLIC,
		LH_CF_ACCESS_CERTS_URL: certsUrl,
		LH_DESKTOP_SERVER: undefined,
		LH_DESKTOP_API_SECRET: undefined,
		LH_ALLOWED_HOSTS: undefined,
		...extra,
	};
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetRemoteAccessCache();
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetRemoteAccessCache();
	}
}

type TokenOptions = { key?: Keys; aud?: string; iss?: string; exp?: string | number; claims?: Record<string, unknown> };

function token(options: TokenOptions = {}): Promise<string> {
	return new SignJWT({ email: "learner@example.com", ...(options.claims ?? {}) })
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(options.iss ?? `https://${TEAM}`)
		.setAudience(options.aud ?? AUD)
		.setIssuedAt()
		.setExpirationTime(options.exp ?? "5m")
		.sign((options.key ?? good).privateKey);
}

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
	return new Request(`http://learn.example.com${path}`, init);
}

describe("remote access configuration", () => {
	it("requires the team domain, AUD and public origin", () => {
		assert.throws(() => remoteAccessConfig({ LH_SERVER_MODE: "remote" }), /LH_CF_ACCESS_TEAM_DOMAIN, LH_CF_ACCESS_AUD, LH_PUBLIC_ORIGIN/);
	});

	it("normalizes the team domain and pins the public origin", () => {
		const config = remoteAccessConfig({ ...remoteEnv({ LH_CF_ACCESS_CERTS_URL: undefined }), LH_CF_ACCESS_TEAM_DOMAIN: "https://Team.CloudflareAccess.com/" });
		assert.equal(config.issuer, "https://team.cloudflareaccess.com");
		assert.equal(config.certsUrl, "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
		assert.equal(config.publicOrigin, PUBLIC);
	});

	it("refuses a public origin with a path, credentials or plain http", () => {
		for (const origin of ["https://learn.example.com/app", "https://u:p@learn.example.com", "http://learn.example.com"]) {
			assert.throws(() => remoteAccessConfig(remoteEnv({ LH_PUBLIC_ORIGIN: origin })), /LH_PUBLIC_ORIGIN/, origin);
		}
		assert.equal(remoteAccessConfig(remoteEnv({ LH_PUBLIC_ORIGIN: "http://localhost:3000" })).publicOrigin, "http://localhost:3000");
	});
});

describe("remote access token check", () => {
	it("does nothing outside remote mode", async () => {
		assert.equal(await remoteAccessRefusal(request("/api/chats"), {}, { keys: jwks }), undefined);
	});

	it("accepts a valid user token and a service token without email", async () => {
		const env = remoteEnv();
		assert.equal(await remoteAccessRefusal(request("/api/chats", { headers: { "cf-access-jwt-assertion": await token() } }), env, { keys: jwks }), undefined);
		const service = await token({ claims: { email: undefined, common_name: "client-id.access" } });
		assert.equal(await remoteAccessRefusal(request("/", { headers: { "cf-access-jwt-assertion": service } }), env, { keys: jwks }), undefined);
	});

	it("refuses missing, wrong-key, wrong-audience, wrong-issuer and expired tokens", async () => {
		const env = remoteEnv();
		const bad = [
			undefined,
			"not-a-jwt",
			await token({ key: other }),
			await token({ aud: "another-app" }),
			await token({ iss: "https://evil.cloudflareaccess.com" }),
			await token({ exp: Math.floor(Date.now() / 1000) - 120 }),
		];
		for (const value of bad) {
			const headers: Record<string, string> = value ? { "cf-access-jwt-assertion": value } : {};
			assert.match(await remoteAccessRefusal(request("/api/chats", { headers }), env, { keys: jwks }) ?? "", /Cloudflare Access/, String(value).slice(0, 20));
		}
	});

	it("leaves only the health probe open", async () => {
		const env = remoteEnv();
		assert.equal(await remoteAccessRefusal(request("/api/health"), env, { keys: jwks }), undefined);
		assert.ok(await remoteAccessRefusal(request("/api/health", { method: "POST" }), env, { keys: jwks }));
		assert.ok(await remoteAccessRefusal(request("/api/health/x"), env, { keys: jwks }));
	});

	it("fails closed when remote mode is misconfigured", async () => {
		const refusal = await remoteAccessRefusal(request("/api/chats", { headers: { "cf-access-jwt-assertion": await token() } }), { LH_SERVER_MODE: "remote" }, { keys: jwks });
		assert.match(refusal ?? "", /not configured/);
	});
});

describe("remote mode pins the public origin", () => {
	it("allows the public host name and uses the https origin for the cross-site check", async () => {
		await withEnv(remoteEnv(), () => {
			assert.equal(browserHostAllowed("learn.example.com", process.env), true);
			assert.equal(browserHostAllowed("other.example.com", process.env), false);
			assert.equal(subscriptionRequestOrigin(request("/api/chats")), PUBLIC);
		});
	});
});

describe("remote mode proxy", () => {
	it("gates pages and API routes with the JWT, fetched from the JWKS URL", async () => {
		await withEnv(remoteEnv(), async () => {
			const page = await proxy(new NextRequest("http://learn.example.com/chat/abc", { headers: { host: "learn.example.com" } }));
			assert.equal(page.status, 403);
			assert.match(await page.text(), /Cloudflare Access/);
			const api = await proxy(new NextRequest("http://learn.example.com/api/chats", { headers: { host: "learn.example.com" } }));
			assert.equal(api.status, 403);
			assert.match((await api.json()).error, /Cloudflare Access/);

			const jwt = await token();
			const okPage = await proxy(new NextRequest("http://learn.example.com/chat/abc", { headers: { host: "learn.example.com", "cf-access-jwt-assertion": jwt } }));
			assert.equal(okPage.headers.get("x-middleware-next"), "1");
		});
	});

	it("passes an https same-origin write and refuses a cross-site write after the JWT check", async () => {
		await withEnv(remoteEnv(), async () => {
			const jwt = await token();
			const write = (origin: string, site: string) => proxy(new NextRequest("http://learn.example.com/api/chats", {
				method: "POST",
				headers: { host: "learn.example.com", origin, "sec-fetch-site": site, "cf-access-jwt-assertion": jwt },
			}));
			assert.equal((await write(PUBLIC, "same-origin")).headers.get("x-middleware-next"), "1");
			assert.equal((await write("https://evil.example", "cross-site")).status, 403);
		});
	});

	it("keeps local browser-only mode synchronous and API-only", () => {
		const keys = { LH_SERVER_MODE: undefined, LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined, LH_ALLOWED_HOSTS: undefined };
		return withEnv(keys, () => {
			const page = proxy(new NextRequest("http://localhost:3000/chat/abc"));
			assert.ok(!(page instanceof Promise));
			assert.equal(page.headers.get("x-middleware-next"), "1");
		});
	});
});

describe("remote mode streamed document route", () => {
	it("checks the JWT before any other work", async () => {
		await withEnv(remoteEnv(), async () => {
			let calls = 0;
			const route = createPluginDocumentRoute({ convertDocument: async () => { calls++; return new Response("x"); } });
			const url = "http://learn.example.com/api/plugins/one/documents/markdown";
			const response = await route.POST(new Request(url, { method: "POST", headers: { host: "learn.example.com" } }), { params: Promise.resolve({ id: "one" }) });
			assert.equal(response.status, 403);
			assert.match((await response.json()).error, /Cloudflare Access/);
			assert.equal((await route.OPTIONS(new Request(url, { method: "OPTIONS" }))).status, 403);
			assert.equal(calls, 0);
		});
	});
});
