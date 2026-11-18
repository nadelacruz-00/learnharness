"use strict";
/*
 * Server probe (fork: remote server mode, Tailscale variant). Used before the
 * window opens and by "Test connection". Two requests:
 *   1. GET /api/health (open): is a LearnHarness server reachable?
 *   2. GET /api/whoami (gated): does the server accept this device's
 *      Tailscale identity?
 * The app sends no credentials: `tailscale serve` on the server adds the
 * identity of this device's Tailscale user to each request.
 */

function networkMessage(error) {
	if (error?.name === "AbortError") return "The server did not answer in time. Is Tailscale connected on this device?";
	const code = error?.cause?.code ?? "";
	const detail = code || error?.message || String(error);
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Cannot find the server name (${detail}). Is Tailscale connected, with MagicDNS on?`;
	return `Cannot reach the server: ${detail}. Is Tailscale connected on this device?`;
}

async function probeServer(origin, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const get = (route) => fetchImpl(`${origin}${route}`, { redirect: "manual", signal: controller.signal });
	try {
		const health = await get("/api/health");
		if (!health.ok) return { ok: false, reason: "http", message: `The server answered with HTTP ${health.status}.` };
		const body = await health.json().catch(() => null);
		if (body?.ok !== true) return { ok: false, reason: "not-learnharness", message: "The server answered, but it is not a LearnHarness server." };

		const identity = await get("/api/whoami");
		const who = await identity.json().catch(() => null);
		if (identity.status === 401 || identity.status === 403) {
			return { ok: false, reason: "auth", message: who?.error ?? "The server refused this device. Log in to Tailscale as an allowed user (not a tagged device)." };
		}
		if (!identity.ok || who?.ok !== true) return { ok: false, reason: "http", message: `The server answered with HTTP ${identity.status}.` };
		return { ok: true, login: typeof who.login === "string" ? who.login : null };
	} catch (error) {
		return { ok: false, reason: "network", message: networkMessage(error) };
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { probeServer };
