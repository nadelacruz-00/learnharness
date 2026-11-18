"use strict";
/*
 * Server profile (fork: remote server mode, Tailscale variant). The desktop
 * app either runs its own local server (mode "local", the default) or
 * connects to a LearnHarness server on the user's tailnet (mode "remote").
 *
 * Stored in <userData>/server-profile.json as {mode, url}. There is no secret:
 * the server identifies this device by its Tailscale login, which
 * `tailscale serve` adds to every request. A profile written by the
 * Cloudflare variant (clientId, secretCipher) loads fine; the old fields are
 * ignored and dropped on the next save.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = "server-profile.json";

function profilePath(userData) {
	return path.join(userData, FILE);
}

/** https only; plain http is allowed for localhost (testing). Origin only. */
function normalizeServerURL(value) {
	let url;
	try { url = new URL(String(value ?? "").trim()); }
	catch { throw new Error("Enter the server address, for example https://learnharness.tail1234.ts.net."); }
	if (url.username || url.password) throw new Error("The server address must not contain a user name or password.");
	if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("Enter only the server address, with no path.");
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server address must start with https://.");
	return url.origin;
}

/** Never throws: a missing or broken file means "local". */
function loadProfile(userData) {
	try {
		const raw = JSON.parse(fs.readFileSync(profilePath(userData), "utf8"));
		const mode = raw?.mode === "remote" ? "remote" : "local";
		const url = typeof raw?.url === "string" ? raw.url : undefined;
		return url ? { mode, url } : { mode };
	} catch {
		return { mode: "local" };
	}
}

function writeProfile(userData, profile) {
	fs.mkdirSync(userData, { recursive: true });
	const target = profilePath(userData);
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(profile, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target);
}

/** Saves the profile. An empty address keeps the stored one. Returns the
 * saved profile. */
function saveProfile(userData, input) {
	const current = loadProfile(userData);
	const mode = input?.mode === "remote" ? "remote" : "local";
	const next = { mode };
	const urlGiven = input?.url !== undefined && String(input.url).trim() !== "";
	if (urlGiven || mode === "remote") next.url = normalizeServerURL(urlGiven ? input.url : current.url);
	else if (current.url) next.url = current.url;
	writeProfile(userData, next);
	return publicProfile(next);
}

/** The view the chooser sees. */
function publicProfile(profile) {
	return { mode: profile.mode, url: profile.url ?? "" };
}

/** The remote server for the main process, or an error message. */
function remoteServerFromProfile(profile) {
	if (profile.mode !== "remote") return { error: "Not in server mode." };
	try {
		return { url: normalizeServerURL(profile.url) };
	} catch (error) {
		return { error: error?.message ?? String(error) };
	}
}

module.exports = { loadProfile, saveProfile, publicProfile, remoteServerFromProfile, normalizeServerURL, profilePath };
