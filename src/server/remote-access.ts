/** Remote server mode (fork addition, Tailscale variant): the server runs in a
 * container that shares the network namespace of a Tailscale sidecar. The
 * sidecar's `tailscale serve` terminates HTTPS on the tailnet name and
 * proxies to `http://127.0.0.1:3000`. For a request from a device owned by a
 * tailnet user, Serve adds `Tailscale-User-Login` (and removes any copy the
 * client sent). This module checks that header against an allowlist.
 *
 * The header is trustworthy only because nothing but the sidecar can reach the
 * server: the server binds loopback inside the shared namespace (checked at
 * start, see assertRemoteAccessConfigured), no host port is published, and
 * other containers on a Docker network cannot reach 127.0.0.1 of this
 * namespace. Tagged devices and Funnel traffic get no identity header, so they
 * are refused.
 *
 * Remote mode keeps browser-only mode on (no desktop secret), so the existing
 * Host and cross-site checks still run after this one. Only the public origin
 * is pinned here: the server sees plain http from Serve, while the browser's
 * Origin is the https tailnet origin. Forwarded headers are never trusted. */

type Env = Record<string, string | undefined>;

export type RemoteAccessConfig = {
	/** Lowercased Tailscale login names that may use this server. */
	allowedLogins: string[];
	/** Origin the browser uses, e.g. `https://learnharness.tail1234.ts.net`. */
	publicOrigin: string;
};

export const HEALTH_PATH = "/api/health";
export const IDENTITY_HEADER = "tailscale-user-login";

export function remoteMode(env: Env = process.env): boolean {
	return env.LH_SERVER_MODE === "remote";
}

function localHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** A Tailscale login name: `user@example.com`, `name@github`, `name@passkey`. */
const LOGIN = /^[^\s@,]+@[^\s@,]+$/;

/** Reads and checks the remote-mode settings. Throws with a clear message
 * when one is missing or malformed, so the server can fail closed at start. */
export function remoteAccessConfig(env: Env = process.env): RemoteAccessConfig {
	const missing = ["LH_TAILSCALE_ALLOWED_LOGINS", "LH_PUBLIC_ORIGIN"].filter((key) => !env[key]?.trim());
	if (missing.length) throw new Error(`Remote server mode needs ${missing.join(", ")}.`);

	const allowedLogins = env.LH_TAILSCALE_ALLOWED_LOGINS!.split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);
	const malformed = allowedLogins.filter((login) => !LOGIN.test(login));
	if (!allowedLogins.length || malformed.length) {
		throw new Error("LH_TAILSCALE_ALLOWED_LOGINS must be a comma-separated list of Tailscale login names, e.g. you@example.com or you@github.");
	}

	let publicURL: URL;
	try { publicURL = new URL(env.LH_PUBLIC_ORIGIN!.trim()); }
	catch { throw new Error("LH_PUBLIC_ORIGIN must be a URL, e.g. https://learnharness.tail1234.ts.net."); }
	if (publicURL.username || publicURL.password || (publicURL.pathname !== "/" && publicURL.pathname !== "") || publicURL.search || publicURL.hash) {
		throw new Error("LH_PUBLIC_ORIGIN must be an origin only, with no path, query or credentials.");
	}
	if (publicURL.protocol !== "https:" && !(publicURL.protocol === "http:" && localHostname(publicURL.hostname))) {
		throw new Error("LH_PUBLIC_ORIGIN must use https (http is allowed only for localhost).");
	}

	return { allowedLogins, publicOrigin: publicURL.origin };
}

/** The pinned public origin in remote mode; undefined otherwise or when the
 * configuration is invalid (the access check then refuses every request). */
export function remotePublicOrigin(env: Env = process.env): string | undefined {
	if (!remoteMode(env)) return;
	try { return remoteAccessConfig(env).publicOrigin; }
	catch { return; }
}

/** Serve may send a non-ASCII value as an RFC 2047 "Q" encoded word. */
function decodeHeaderWord(value: string): string {
	const match = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value);
	if (!match) return value;
	const bytes: number[] = [];
	const text = match[1] ?? "";
	for (let index = 0; index < text.length; index++) {
		const hex = text.slice(index + 1, index + 3);
		if (text[index] === "_") bytes.push(0x20);
		else if (text[index] === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(parseInt(hex, 16));
			index += 2;
		} else bytes.push(text.charCodeAt(index));
	}
	return Buffer.from(bytes).toString("utf8");
}

/** The caller's Tailscale login from the Serve header, lowercased, or
 * undefined when the header is missing or empty. */
export function tailscaleLogin(request: Request): string | undefined {
	const raw = request.headers.get(IDENTITY_HEADER)?.trim();
	if (!raw) return;
	return decodeHeaderWord(raw).trim().toLowerCase() || undefined;
}

/** Returns the refusal message, or undefined when the request may continue.
 * Outside remote mode it always returns undefined. Fails closed: a missing
 * header, a login that is not on the list and a broken configuration all
 * refuse. */
export function remoteAccessRefusal(request: Request, env: Env = process.env): string | undefined {
	if (!remoteMode(env)) return;
	let config: RemoteAccessConfig;
	try { config = remoteAccessConfig(env); }
	catch (error) { return `This server is not configured correctly: ${(error as Error).message}`; }

	const method = request.method.toUpperCase();
	if ((method === "GET" || method === "HEAD") && new URL(request.url).pathname === HEALTH_PATH) return;

	const login = tailscaleLogin(request);
	if (!login) return "Open this server over Tailscale from a device that is logged in as an allowed user (tagged devices have no user).";
	if (!config.allowedLogins.includes(login)) return `The Tailscale user ${login} may not use this server.`;
}

/** Standalone Next binds `HOSTNAME` (default 0.0.0.0). In remote mode it must
 * be loopback, so that only the Tailscale sidecar in the shared network
 * namespace can reach the server and set the identity header. */
export function remoteBindRefusal(env: Env = process.env): string | undefined {
	if (!remoteMode(env)) return;
	const host = env.HOSTNAME?.trim().toLowerCase();
	if (host === "127.0.0.1" || host === "::1" || host === "localhost") return;
	return `Remote server mode must listen on loopback only: set HOSTNAME=127.0.0.1 (now ${host ? `"${host}"` : "unset, which means 0.0.0.0"}).`;
}

/** Called once at server start: remote mode with a broken configuration must
 * not start serving. */
export function assertRemoteAccessConfigured(env: Env = process.env): void {
	if (!remoteMode(env)) return;
	const config = remoteAccessConfig(env);
	const bind = remoteBindRefusal(env);
	if (bind) throw new Error(bind);
	console.log(`[remote-access] Remote server mode (Tailscale): ${config.publicOrigin}, ${config.allowedLogins.length} allowed login(s)`);
}

/** Body of GET /api/whoami. Runs only after the proxy let the request in. */
export function remoteIdentityResponse(request: Request, env: Env = process.env): Response {
	const remote = remoteMode(env);
	return Response.json({ ok: true, remote, login: remote ? tailscaleLogin(request) ?? null : null }, { headers: { "Cache-Control": "no-store" } });
}
