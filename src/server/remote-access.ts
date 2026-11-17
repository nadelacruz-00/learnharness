import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Remote server mode (fork addition): the server runs behind a Cloudflare
 * Tunnel with Cloudflare Access in front. Access signs every request it lets
 * through with a JWT in `Cf-Access-Jwt-Assertion`; this module verifies it.
 * The app checks the JWT itself because other containers on the tunnel's
 * Docker network can reach the server without passing through Access.
 *
 * Remote mode keeps browser-only mode on (no desktop secret), so the existing
 * Host and cross-site checks still run after this one. Only the public origin
 * is pinned here: the container sees plain http behind the tunnel, while the
 * browser's Origin is the https public origin. Forwarded headers are never
 * trusted. */

type Env = Record<string, string | undefined>;

export type RemoteAccessConfig = {
	/** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. */
	teamDomain: string;
	/** Expected `iss` claim: `https://<teamDomain>`. */
	issuer: string;
	/** Expected `aud` claim: the Access application's AUD tag. */
	audience: string;
	/** Public origin the browser uses, e.g. `https://learn.example.com`. */
	publicOrigin: string;
	/** JWKS URL. `LH_CF_ACCESS_CERTS_URL` overrides it for smoke tests only. */
	certsUrl: string;
};

export const HEALTH_PATH = "/api/health";
const ACCESS_HEADER = "cf-access-jwt-assertion";

export function remoteMode(env: Env = process.env): boolean {
	return env.LH_SERVER_MODE === "remote";
}

function localHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** Reads and checks the remote-mode settings. Throws with a clear message
 * when one is missing or malformed, so the server can fail closed at start. */
export function remoteAccessConfig(env: Env = process.env): RemoteAccessConfig {
	const missing = ["LH_CF_ACCESS_TEAM_DOMAIN", "LH_CF_ACCESS_AUD", "LH_PUBLIC_ORIGIN"].filter((key) => !env[key]?.trim());
	if (missing.length) throw new Error(`Remote server mode needs ${missing.join(", ")}.`);

	const teamDomain = env.LH_CF_ACCESS_TEAM_DOMAIN!.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(teamDomain)) {
		throw new Error("LH_CF_ACCESS_TEAM_DOMAIN must be a host name, e.g. myteam.cloudflareaccess.com.");
	}
	const issuer = `https://${teamDomain}`;

	let publicURL: URL;
	try { publicURL = new URL(env.LH_PUBLIC_ORIGIN!.trim()); }
	catch { throw new Error("LH_PUBLIC_ORIGIN must be a URL, e.g. https://learn.example.com."); }
	if (publicURL.username || publicURL.password || (publicURL.pathname !== "/" && publicURL.pathname !== "") || publicURL.search || publicURL.hash) {
		throw new Error("LH_PUBLIC_ORIGIN must be an origin only, with no path, query or credentials.");
	}
	if (publicURL.protocol !== "https:" && !(publicURL.protocol === "http:" && localHostname(publicURL.hostname))) {
		throw new Error("LH_PUBLIC_ORIGIN must use https (http is allowed only for localhost).");
	}

	const certsUrl = env.LH_CF_ACCESS_CERTS_URL?.trim() || `${issuer}/cdn-cgi/access/certs`;
	return { teamDomain, issuer, audience: env.LH_CF_ACCESS_AUD!.trim(), publicOrigin: publicURL.origin, certsUrl };
}

/** The pinned public origin in remote mode; undefined otherwise or when the
 * configuration is invalid (the access check then refuses every request). */
export function remotePublicOrigin(env: Env = process.env): string | undefined {
	if (!remoteMode(env)) return;
	try { return remoteAccessConfig(env).publicOrigin; }
	catch { return; }
}

let cachedJWKS: { url: string; keys: JWTVerifyGetKey } | undefined;

/** One remote key set per URL for the process: jose caches the keys and
 * refetches them when a token names an unknown key. */
function remoteKeys(url: string): JWTVerifyGetKey {
	if (cachedJWKS?.url !== url) cachedJWKS = { url, keys: createRemoteJWKSet(new URL(url)) };
	return cachedJWKS.keys;
}

export type RemoteAccessDeps = { keys?: JWTVerifyGetKey };

/** Returns the refusal message, or undefined when the request may continue.
 * Outside remote mode it always returns undefined. Fails closed: a missing,
 * invalid or unverifiable token and a broken configuration all refuse. */
export async function remoteAccessRefusal(request: Request, env: Env = process.env, deps: RemoteAccessDeps = {}): Promise<string | undefined> {
	if (!remoteMode(env)) return;
	let config: RemoteAccessConfig;
	try { config = remoteAccessConfig(env); }
	catch (error) { return `This server is not configured correctly: ${(error as Error).message}`; }

	const method = request.method.toUpperCase();
	if ((method === "GET" || method === "HEAD") && new URL(request.url).pathname === HEALTH_PATH) return;

	const token = request.headers.get(ACCESS_HEADER);
	if (!token) return "Sign in through Cloudflare Access to use this server.";
	try {
		// Service tokens carry `common_name` and no `email`, so no identity
		// claim is required beyond a valid signature, issuer, audience and expiry.
		await jwtVerify(token, deps.keys ?? remoteKeys(config.certsUrl), {
			issuer: config.issuer,
			audience: config.audience,
			algorithms: ["RS256"],
			requiredClaims: ["exp", "iat"],
			clockTolerance: 30,
		});
	} catch {
		return "The Cloudflare Access token is not valid for this server. Sign in again.";
	}
}

/** Called once at server start: remote mode with a broken configuration must
 * not start serving. */
export function assertRemoteAccessConfigured(env: Env = process.env): void {
	if (!remoteMode(env)) return;
	const config = remoteAccessConfig(env);
	if (env.LH_CF_ACCESS_CERTS_URL) console.warn(`[remote-access] Using LH_CF_ACCESS_CERTS_URL=${config.certsUrl}. Use this only for smoke tests.`);
	console.log(`[remote-access] Remote server mode: ${config.publicOrigin}, Access team ${config.teamDomain}`);
}

/** Test hook: forget the cached key set. */
export function resetRemoteAccessCache(): void {
	cachedJWKS = undefined;
}
