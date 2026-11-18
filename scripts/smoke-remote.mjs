/**
 * smoke-remote.mjs (fork: remote server mode, Tailscale variant). Checks a
 * running server in remote mode without a tailnet. It plays the part of
 * `tailscale serve`: it sends the `Tailscale-User-Login` header itself, so it
 * must run where Serve runs, in the server's network namespace:
 *
 *   docker run --rm --network container:<netns holder> -v "$PWD":/w -w /w \
 *     <node image> node scripts/smoke-remote.mjs \
 *       --login smoke@example.com --unreachable http://<holder IP>:3000
 *
 * The server must run with LH_SERVER_MODE=remote,
 * LH_TAILSCALE_ALLOWED_LOGINS=<--login> and LH_PUBLIC_ORIGIN=<--origin>.
 * --unreachable (repeatable) names URLs that must NOT answer (for example the
 * namespace's Docker network address): the server must listen on loopback only.
 *
 * Use it only against a throwaway data volume: it imports a test chat.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createArchive } from "../src/server/data-archive.mjs";

const { values } = parseArgs({ options: {
	base: { type: "string", default: "http://127.0.0.1:3000" },
	origin: { type: "string", default: "https://learnharness.tail1234.ts.net" },
	login: { type: "string", default: "smoke@example.com" },
	unreachable: { type: "string", multiple: true, default: [] },
	"wait-ms": { type: "string", default: "180000" },
} });
const base = values.base.replace(/\/+$/, "");
const host = new URL(values.origin).host;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`[smoke-remote] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
};
// Serve keeps the client's Host (the tailnet name); fetch cannot set Host, so
// the requests use the base URL's host, which the server allows as an IP.
const get = (route, login, init = {}) => fetch(`${base}${route}`, {
	redirect: "manual", ...init,
	headers: { ...(login ? { "tailscale-user-login": login } : {}), ...(init.headers ?? {}) },
});

// Wait for the server.
const deadline = Date.now() + Number(values["wait-ms"]);
for (;;) {
	try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
	if (Date.now() > deadline) { console.error("[smoke-remote] server did not come up"); process.exit(1); }
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

const health = await get("/api/health");
check("health is open", health.status === 200 && (await health.json()).ok === true, String(health.status));

for (const route of ["/", "/chat/smoke", "/settings", "/api/chats", "/api/settings", "/api/data/export", "/api/whoami"]) {
	const res = await get(route);
	check(`no identity: ${route} refused`, res.status === 403, String(res.status));
}
for (const [label, login] of [["unknown user", "intruder@example.com"], ["lookalike user", `${values.login}.evil`], ["empty header", " "]]) {
	const res = await get("/api/chats", login);
	check(`${label}: refused`, res.status === 403, String(res.status));
}
const forwarded = await get("/api/chats", undefined, { headers: { "x-forwarded-user": values.login, "tailscale-user-name": values.login } });
check("other identity headers: refused", forwarded.status === 403, String(forwarded.status));

const page = await get("/", values.login.toUpperCase());
check("allowed user (any case): page renders", page.status === 200, String(page.status));
const whoami = await get("/api/whoami", values.login);
const who = await whoami.json().catch(() => ({}));
check("whoami names the caller", whoami.status === 200 && who.login === values.login.toLowerCase() && who.remote === true, `${whoami.status} ${who.login}`);
// Web app icons: favicon.ico is outside Proxy (no data); the app/ icon
// routes pass the gate like pages, so tailnet users get them.
const favicon = await get("/favicon.ico");
check("favicon.ico is served without identity", favicon.status === 200, String(favicon.status));
for (const route of ["/icon.svg", "/apple-icon.png"]) {
	const refused = await get(route);
	const icon = await get(route, values.login);
	check(`${route}: refused without identity, served to the allowed user`, refused.status === 403 && icon.status === 200 && /image\//.test(icon.headers.get("content-type") ?? ""), `${refused.status}/${icon.status} ${icon.headers.get("content-type")}`);
}
const chats = await get("/api/chats", values.login);
check("allowed user: API answers", chats.status === 200, String(chats.status));

const cross = await get("/api/data/import", values.login, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/gzip" }, body: "x" });
check("cross-site write refused", cross.status === 403, String(cross.status));
// A same-origin write from the pinned tailnet origin passes the gate; the
// route then refuses the junk body itself (400, not 403).
const sameOrigin = await get("/api/data/import", values.login, { method: "POST", headers: { origin: values.origin, "sec-fetch-site": "same-origin", "content-type": "application/gzip" }, body: "x" });
check(`same-origin write from ${host} passes the gate`, sameOrigin.status === 400, String(sameOrigin.status));

// Import a one-chat archive into the (throwaway) server, then refuse a second without replace.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-remote-"));
fs.mkdirSync(path.join(dir, "chats"));
fs.writeFileSync(path.join(dir, "chats", "chat_smoke.json"), JSON.stringify({ id: "chat_smoke", title: "Smoke", messages: [], createdAt: new Date().toISOString() }));
const archive = createArchive(dir);
const importOnce = (query = "") => get(`/api/data/import${query}`, values.login, { method: "POST", headers: { "content-type": "application/gzip" }, body: archive });
const first = await importOnce();
const firstBody = await first.json().catch(() => ({}));
check("import into an empty server", first.status === 200 && firstBody.ok === true, `${first.status} ${firstBody.error ?? ""}`);
const second = await importOnce();
const secondBody = await second.json().catch(() => ({}));
check("second import needs replace", second.status === 409 && secondBody.error === "server_has_data", `${second.status} ${secondBody.error ?? ""}`);
const replaced = await importOnce("?replace=1");
const replacedBody = await replaced.json().catch(() => ({}));
check("replace makes a backup", replaced.status === 200 && Boolean(replacedBody.backup), `${replaced.status} ${replacedBody.backup ?? ""}`);
const exported = await get("/api/data/export", values.login);
check("export returns gzip", exported.status === 200 && (exported.headers.get("content-type") ?? "").includes("gzip"), `${exported.status} ${exported.headers.get("content-type")}`);
fs.rmSync(dir, { recursive: true, force: true });

// The server must not answer on any non-loopback address.
for (const url of values.unreachable) {
	let answered = "";
	try {
		const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) });
		answered = `HTTP ${res.status}`;
	} catch { /* refused or timed out: good */ }
	check(`not reachable at ${url}`, !answered, answered || "connection failed");
}

console.log(failures ? `[smoke-remote] ${failures} check(s) failed` : "[smoke-remote] all checks passed");
process.exit(failures ? 1 : 0);
