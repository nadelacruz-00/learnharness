/**
 * Remote server mode (fork, Tailscale variant): every request must carry a
 * `Tailscale-User-Login` header (added by `tailscale serve`) with an allowed
 * login. Pages are gated as well as the API. The server must bind loopback.
 * Local modes are unchanged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { browserHostAllowed, subscriptionRequestOrigin } from "../src/server/desktop-access.ts";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";
import {
	assertRemoteAccessConfigured, remoteAccessConfig, remoteAccessRefusal, remoteBindRefusal, remoteIdentityResponse, tailscaleLogin,
} from "../src/server/remote-access.ts";

const HOST = "learnharness.tail1234.ts.net";
const PUBLIC = `https://${HOST}`;
const LOGIN = "learner@example.com";

function remoteEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		LH_SERVER_MODE: "remote",
		LH_TAILSCALE_ALLOWED_LOGINS: `${LOGIN}, Second@GitHub`,
		LH_PUBLIC_ORIGIN: PUBLIC,
		HOSTNAME: "127.0.0.1",
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
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
	return new Request(`http://${HOST}${path}`, init);
}

const as = (login: string, headers: Record<string, string> = {}) => ({ headers: { "tailscale-user-login": login, ...headers } });

describe("remote access configuration", () => {
	it("requires the allowed logins and the public origin", () => {
		assert.throws(() => remoteAccessConfig({ LH_SERVER_MODE: "remote" }), /LH_TAILSCALE_ALLOWED_LOGINS, LH_PUBLIC_ORIGIN/);
	});

	it("lowercases the logins and pins the public origin", () => {
		const config = remoteAccessConfig(remoteEnv());
		assert.deepEqual(config.allowedLogins, [LOGIN, "second@github"]);
		assert.equal(config.publicOrigin, PUBLIC);
	});

	it("refuses malformed logins", () => {
		for (const logins of [",", "learner", "a b@example.com", "@example.com", "learner@"]) {
			assert.throws(() => remoteAccessConfig(remoteEnv({ LH_TAILSCALE_ALLOWED_LOGINS: logins })), /LH_TAILSCALE_ALLOWED_LOGINS/, logins);
		}
	});

	it("refuses a public origin with a path, credentials or plain http", () => {
		for (const origin of [`${PUBLIC}/app`, `https://u:p@${HOST}`, `http://${HOST}`]) {
			assert.throws(() => remoteAccessConfig(remoteEnv({ LH_PUBLIC_ORIGIN: origin })), /LH_PUBLIC_ORIGIN/, origin);
		}
		assert.equal(remoteAccessConfig(remoteEnv({ LH_PUBLIC_ORIGIN: "http://localhost:3000" })).publicOrigin, "http://localhost:3000");
	});
});

describe("remote mode bind address", () => {
	it("accepts only a loopback HOSTNAME", () => {
		for (const host of ["127.0.0.1", "::1", "localhost"]) assert.equal(remoteBindRefusal(remoteEnv({ HOSTNAME: host })), undefined, host);
		for (const host of [undefined, "", "0.0.0.0", "::", "learnharness-app", "100.64.0.1"]) {
			assert.match(remoteBindRefusal(remoteEnv({ HOSTNAME: host })) ?? "", /loopback/, String(host));
		}
		assert.equal(remoteBindRefusal({ HOSTNAME: "0.0.0.0" }), undefined, "local modes are not checked");
	});

	it("refuses to start with a wide bind or a broken configuration", () => {
		assert.throws(() => assertRemoteAccessConfigured(remoteEnv({ HOSTNAME: "0.0.0.0" })), /loopback/);
		assert.throws(() => assertRemoteAccessConfigured(remoteEnv({ LH_TAILSCALE_ALLOWED_LOGINS: undefined })), /LH_TAILSCALE_ALLOWED_LOGINS/);
		assert.doesNotThrow(() => assertRemoteAccessConfigured({}));
	});
});

describe("remote access identity check", () => {
	it("does nothing outside remote mode", () => {
		assert.equal(remoteAccessRefusal(request("/api/chats"), {}), undefined);
	});

	it("accepts an allowed login in any letter case", () => {
		const env = remoteEnv();
		assert.equal(remoteAccessRefusal(request("/api/chats", as(LOGIN)), env), undefined);
		assert.equal(remoteAccessRefusal(request("/", as("SECOND@github")), env), undefined);
	});

	it("decodes an RFC 2047 Q-encoded login", () => {
		assert.equal(tailscaleLogin(request("/", as("=?utf-8?q?j=C3=B6rg@example.com?="))), "jörg@example.com");
		assert.equal(remoteAccessRefusal(request("/", as("=?utf-8?q?j=C3=B6rg@example.com?=")), remoteEnv({ LH_TAILSCALE_ALLOWED_LOGINS: "jörg@example.com" })), undefined);
	});

	it("refuses a missing, empty or unknown login", () => {
		const env = remoteEnv();
		assert.match(remoteAccessRefusal(request("/api/chats"), env) ?? "", /Tailscale/);
		assert.match(remoteAccessRefusal(request("/api/chats", as("  ")), env) ?? "", /Tailscale/);
		assert.match(remoteAccessRefusal(request("/api/chats", as("intruder@example.com")), env) ?? "", /intruder@example\.com may not/);
		assert.match(remoteAccessRefusal(request("/api/chats", as(`${LOGIN}.evil`)), env) ?? "", /may not/);
		// Other identity-looking headers do not count.
		assert.ok(remoteAccessRefusal(request("/api/chats", { headers: { "x-forwarded-user": LOGIN, "tailscale-user-name": LOGIN } }), env));
	});

	it("leaves only the health probe open", () => {
		const env = remoteEnv();
		assert.equal(remoteAccessRefusal(request("/api/health"), env), undefined);
		assert.equal(remoteAccessRefusal(request("/api/health", { method: "HEAD" }), env), undefined);
		assert.ok(remoteAccessRefusal(request("/api/health", { method: "POST" }), env));
		assert.ok(remoteAccessRefusal(request("/api/health/x"), env));
		assert.ok(remoteAccessRefusal(request("/api/whoami"), env));
	});

	it("fails closed when remote mode is misconfigured", () => {
		const refusal = remoteAccessRefusal(request("/api/chats", as(LOGIN)), { LH_SERVER_MODE: "remote" });
		assert.match(refusal ?? "", /not configured/);
	});
});

describe("whoami", () => {
	it("returns only the caller's own login in remote mode", async () => {
		const body = await remoteIdentityResponse(request("/api/whoami", as("Learner@Example.com")), remoteEnv()).json();
		assert.deepEqual(body, { ok: true, remote: true, login: LOGIN });
		const local = await remoteIdentityResponse(request("/api/whoami", as(LOGIN)), {}).json();
		assert.deepEqual(local, { ok: true, remote: false, login: null });
	});
});

describe("remote mode pins the public origin", () => {
	it("allows the tailnet host name and uses the https origin for the cross-site check", async () => {
		await withEnv(remoteEnv(), () => {
			assert.equal(browserHostAllowed(HOST, process.env), true);
			assert.equal(browserHostAllowed("other.tail1234.ts.net", process.env), false);
			assert.equal(subscriptionRequestOrigin(request("/api/chats")), PUBLIC);
		});
	});
});

describe("remote mode proxy", () => {
	it("gates pages and API routes with the identity header", async () => {
		await withEnv(remoteEnv(), async () => {
			const page = proxy(new NextRequest(`http://${HOST}/chat/abc`, { headers: { host: HOST } }));
			assert.equal(page.status, 403);
			assert.match(await page.text(), /Tailscale/);
			const api = proxy(new NextRequest(`http://${HOST}/api/chats`, { headers: { host: HOST } }));
			assert.equal(api.status, 403);
			assert.match((await api.json()).error, /Tailscale/);
			const stranger = proxy(new NextRequest(`http://${HOST}/api/chats`, { headers: { host: HOST, "tailscale-user-login": "stranger@example.com" } }));
			assert.equal(stranger.status, 403);

			const okPage = proxy(new NextRequest(`http://${HOST}/chat/abc`, { headers: { host: HOST, "tailscale-user-login": LOGIN } }));
			assert.equal(okPage.headers.get("x-middleware-next"), "1");
		});
	});

	it("passes an https same-origin write and refuses a cross-site write after the identity check", async () => {
		await withEnv(remoteEnv(), () => {
			const write = (origin: string, site: string) => proxy(new NextRequest(`http://${HOST}/api/chats`, {
				method: "POST",
				headers: { host: HOST, origin, "sec-fetch-site": site, "tailscale-user-login": LOGIN },
			}));
			assert.equal(write(PUBLIC, "same-origin").headers.get("x-middleware-next"), "1");
			assert.equal(write("https://evil.example", "cross-site").status, 403);
		});
	});

	it("serves the web app icons to tailnet users only; favicon.ico skips Proxy", async () => {
		await withEnv(remoteEnv(), () => {
			for (const path of ["/icon.svg", "/apple-icon.png"]) {
				assert.equal(proxy(new NextRequest(`http://${HOST}${path}`, { headers: { host: HOST } })).status, 403, path);
				const ok = proxy(new NextRequest(`http://${HOST}${path}`, { headers: { host: HOST, "tailscale-user-login": LOGIN } }));
				assert.equal(ok.headers.get("x-middleware-next"), "1", path);
			}
		});
	});

	it("refuses a foreign Host even with a valid login", async () => {
		await withEnv(remoteEnv(), () => {
			const response = proxy(new NextRequest("http://evil.example/api/chats", { headers: { host: "evil.example", "tailscale-user-login": LOGIN } }));
			assert.equal(response.status, 403);
		});
	});

	it("keeps local browser-only mode API-only", () => {
		const keys = { LH_SERVER_MODE: undefined, LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined, LH_ALLOWED_HOSTS: undefined };
		return withEnv(keys, () => {
			const page = proxy(new NextRequest("http://localhost:3000/chat/abc"));
			assert.equal(page.headers.get("x-middleware-next"), "1");
		});
	});
});

describe("remote mode streamed document route", () => {
	it("checks the identity header before any other work", async () => {
		await withEnv(remoteEnv(), async () => {
			let calls = 0;
			const route = createPluginDocumentRoute({ convertDocument: async () => { calls++; return new Response("x"); } });
			const url = `http://${HOST}/api/plugins/one/documents/markdown`;
			const response = await route.POST(new Request(url, { method: "POST", headers: { host: HOST } }), { params: Promise.resolve({ id: "one" }) });
			assert.equal(response.status, 403);
			assert.match((await response.json()).error, /Tailscale/);
			assert.equal((await route.OPTIONS(new Request(url, { method: "OPTIONS" }))).status, 403);
			assert.equal(calls, 0);
		});
	});
});
