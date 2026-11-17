"use strict";
/*
 * Cloudflare Access service-token headers (fork: remote server mode).
 * Called for EVERY outgoing request, like desktopAPIHeaders: the token is
 * added only to requests for the remote server's exact origin and removed
 * from all others, so a redirect or a third-party request never carries it.
 * Never expose this function or the token to preload or the renderer.
 */
const ID_HEADER = "cf-access-client-id";
const SECRET_HEADER = "cf-access-client-secret";

function stripAccessHeaders(requestHeaders) {
	const headers = { ...requestHeaders };
	for (const name of Object.keys(headers)) {
		const lower = name.toLowerCase();
		if (lower === ID_HEADER || lower === SECRET_HEADER) delete headers[name];
	}
	return headers;
}

function remoteAccessHeaders(details, origin, credentials) {
	const headers = stripAccessHeaders(details.requestHeaders);
	if (!credentials?.clientId || !credentials?.clientSecret || !origin) return headers;
	try {
		const target = new URL(details.url);
		if (target.origin !== origin || target.username || target.password) return headers;
		headers["CF-Access-Client-Id"] = credentials.clientId;
		headers["CF-Access-Client-Secret"] = credentials.clientSecret;
	} catch { /* Unparseable URLs fail closed. */ }
	return headers;
}

/** Health probe used before opening the window and by "Test connection".
 * Classifies the answer so the chooser can say what is wrong. */
async function probeServer(origin, credentials, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(`${origin}/api/health`, {
			headers: credentials ? { "CF-Access-Client-Id": credentials.clientId, "CF-Access-Client-Secret": credentials.clientSecret } : {},
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.ok) {
			const body = await response.json().catch(() => null);
			if (body?.ok === true) return { ok: true };
			return { ok: false, reason: "not-learnharness", message: "The server answered, but it is not a LearnHarness server." };
		}
		const location = response.headers.get("location") ?? "";
		if ((response.status >= 300 && response.status < 400 && /cloudflareaccess\.com/i.test(location)) || response.status === 401 || response.status === 403) {
			return { ok: false, reason: "auth", message: "Cloudflare Access refused the service token. Check the client ID and secret." };
		}
		return { ok: false, reason: "http", message: `The server answered with HTTP ${response.status}.` };
	} catch (error) {
		const aborted = error?.name === "AbortError";
		return { ok: false, reason: "network", message: aborted ? "The server did not answer in time." : `Cannot reach the server: ${error?.cause?.code ?? error?.message ?? error}` };
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { remoteAccessHeaders, stripAccessHeaders, probeServer, ID_HEADER, SECRET_HEADER };
