/**
 * smoke-remote.mjs (fork: remote server mode). Checks a running server in
 * remote mode from the outside, with a throwaway signing key:
 *
 *   1. start this script: it serves a JWKS on --jwks-port and prints its URL;
 *   2. start the server with LH_CF_ACCESS_CERTS_URL=<that URL>, plus
 *      LH_CF_ACCESS_TEAM_DOMAIN / LH_CF_ACCESS_AUD matching --team / --aud;
 *   3. the script waits for /api/health, runs the checks, and exits 0 or 1.
 *
 *   node scripts/smoke-remote.mjs --base http://127.0.0.1:3000 \
 *     --team smoke.cloudflareaccess.com --aud smoke-aud --jwks-port 4799
 *
 * Use it only against a throwaway data volume: it imports a test chat.
 */
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createArchive } from "../src/server/data-archive.mjs";

const { values } = parseArgs({ options: {
	base: { type: "string", default: "http://127.0.0.1:3000" },
	team: { type: "string", default: "smoke.cloudflareaccess.com" },
	aud: { type: "string", default: "smoke-aud" },
	"jwks-port": { type: "string", default: "4799" },
	"jwks-host": { type: "string", default: "0.0.0.0" },
	"wait-ms": { type: "string", default: "180000" },
} });
const base = values.base.replace(/\/+$/, "");

const good = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(good.publicKey)), kid: "smoke", alg: "RS256", use: "sig" };
const jwks = createServer((req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => jwks.listen(Number(values["jwks-port"]), values["jwks-host"], resolve));
console.log(`[smoke-remote] JWKS on http://${values["jwks-host"]}:${values["jwks-port"]}/certs`);

const token = ({ key = good, aud = values.aud, email = "smoke@example.com" } = {}) => new SignJWT(email ? { email } : { common_name: "smoke.access" })
	.setProtectedHeader({ alg: "RS256", kid: "smoke" })
	.setIssuer(`https://${values.team}`).setAudience(aud).setIssuedAt().setExpirationTime("5m")
	.sign(key.privateKey);

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`[smoke-remote] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
};
const get = (route, jwt, init = {}) => fetch(`${base}${route}`, { redirect: "manual", ...init, headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...(init.headers ?? {}) } });

// Wait for the server.
const deadline = Date.now() + Number(values["wait-ms"]);
for (;;) {
	try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
	if (Date.now() > deadline) { console.error("[smoke-remote] server did not come up"); process.exit(1); }
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

try {
	const health = await get("/api/health");
	check("health is open", health.status === 200 && (await health.json()).ok === true, String(health.status));

	for (const route of ["/", "/chat/smoke", "/settings", "/api/chats", "/api/settings", "/api/data/export"]) {
		const res = await get(route);
		check(`no token: ${route} refused`, res.status === 403, String(res.status));
	}
	for (const [label, jwt] of [["wrong key", await token({ key: other })], ["wrong audience", await token({ aud: "other-app" })], ["garbage", "x.y.z"]]) {
		const res = await get("/api/chats", jwt);
		check(`${label}: refused`, res.status === 403, String(res.status));
	}

	const user = await token();
	const service = await token({ email: null });
	const page = await get("/", user);
	check("user token: page renders", page.status === 200, String(page.status));
	const chats = await get("/api/chats", service);
	check("service token: API answers", chats.status === 200, String(chats.status));

	const cross = await get("/api/data/import", user, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/gzip" }, body: "x" });
	check("cross-site write refused", cross.status === 403, String(cross.status));

	// Import a one-chat archive into the (throwaway) server, then refuse a second without replace.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-remote-"));
	fs.mkdirSync(path.join(dir, "chats"));
	fs.writeFileSync(path.join(dir, "chats", "chat_smoke.json"), JSON.stringify({ id: "chat_smoke", title: "Smoke", messages: [], createdAt: new Date().toISOString() }));
	const archive = createArchive(dir);
	const importOnce = (query = "") => get(`/api/data/import${query}`, service, { method: "POST", headers: { "content-type": "application/gzip" }, body: archive });
	const first = await importOnce();
	const firstBody = await first.json().catch(() => ({}));
	check("import into an empty server", first.status === 200 && firstBody.ok === true, `${first.status} ${firstBody.error ?? ""}`);
	const second = await importOnce();
	const secondBody = await second.json().catch(() => ({}));
	check("second import needs replace", second.status === 409 && secondBody.error === "server_has_data", `${second.status} ${secondBody.error ?? ""}`);
	const replaced = await importOnce("?replace=1");
	const replacedBody = await replaced.json().catch(() => ({}));
	check("replace makes a backup", replaced.status === 200 && Boolean(replacedBody.backup), `${replaced.status} ${replacedBody.backup ?? ""}`);
	const exported = await get("/api/data/export", service);
	check("export returns gzip", exported.status === 200 && (exported.headers.get("content-type") ?? "").includes("gzip"), `${exported.status} ${exported.headers.get("content-type")}`);
	fs.rmSync(dir, { recursive: true, force: true });
} finally {
	jwks.close();
}

console.log(failures ? `[smoke-remote] ${failures} check(s) failed` : "[smoke-remote] all checks passed");
process.exit(failures ? 1 : 0);
