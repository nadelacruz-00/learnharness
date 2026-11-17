"use strict";
/*
 * Server profile (fork: remote server mode). The desktop app either runs its
 * own local server (mode "local", the default) or connects to a LearnHarness
 * server behind Cloudflare Access (mode "remote") with a service token.
 *
 * Stored in <userData>/server-profile.json. The token secret is stored only
 * as ciphertext from Electron's safeStorage (OS keyring). A plaintext keyring
 * fallback (Linux "basic_text") is refused. The secret never reaches the
 * renderer.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = "server-profile.json";
const WEAK_BACKENDS = new Set(["basic_text", "unknown"]);

function profilePath(userData) {
	return path.join(userData, FILE);
}

/** https only; plain http is allowed for localhost (testing). Origin only. */
function normalizeServerURL(value) {
	let url;
	try { url = new URL(String(value ?? "").trim()); }
	catch { throw new Error("Enter the server address, for example https://learn.example.com."); }
	if (url.username || url.password) throw new Error("The server address must not contain a user name or password.");
	if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("Enter only the server address, with no path.");
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server address must start with https://.");
	return url.origin;
}

function normalizeClientId(value) {
	const id = String(value ?? "").trim();
	if (!/^[A-Za-z0-9._-]{8,200}$/.test(id)) throw new Error("The Cloudflare Access client ID looks wrong. It ends with .access.");
	return id;
}

/** Never throws: a missing or broken file means "local". */
function loadProfile(userData) {
	try {
		const raw = JSON.parse(fs.readFileSync(profilePath(userData), "utf8"));
		const mode = raw?.mode === "remote" ? "remote" : "local";
		const url = typeof raw?.url === "string" ? raw.url : undefined;
		const clientId = typeof raw?.clientId === "string" ? raw.clientId : undefined;
		const secretCipher = typeof raw?.secretCipher === "string" ? raw.secretCipher : undefined;
		return { mode, url, clientId, secretCipher };
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

function assertStrongStorage(safeStorage) {
	if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("This system has no keyring for secrets, so the service token cannot be stored safely.");
	const backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : undefined;
	if (backend && WEAK_BACKENDS.has(backend)) {
		throw new Error(`The system keyring is not available (backend "${backend}"), so the service token cannot be stored safely. Unlock or install a keyring (for example GNOME Keyring), then try again.`);
	}
}

/** Saves the profile. A new secret replaces the stored one; an empty secret
 * keeps the stored one. Returns the saved (public) profile. */
function saveProfile(userData, input, safeStorage) {
	const current = loadProfile(userData);
	const mode = input?.mode === "remote" ? "remote" : "local";
	const next = { mode };
	const urlGiven = input?.url !== undefined && String(input.url).trim() !== "";
	if (urlGiven || mode === "remote") next.url = normalizeServerURL(urlGiven ? input.url : current.url);
	const idGiven = input?.clientId !== undefined && String(input.clientId).trim() !== "";
	if (idGiven || mode === "remote") next.clientId = normalizeClientId(idGiven ? input.clientId : current.clientId);
	const secret = typeof input?.secret === "string" ? input.secret.trim() : "";
	if (secret) {
		assertStrongStorage(safeStorage);
		next.secretCipher = safeStorage.encryptString(secret).toString("base64");
	} else if (current.secretCipher) {
		next.secretCipher = current.secretCipher;
	}
	if (mode === "remote" && !next.secretCipher) throw new Error("Enter the Cloudflare Access client secret.");
	writeProfile(userData, next);
	return publicProfile(next);
}

/** The view the chooser may see: no secret, only whether one is stored. */
function publicProfile(profile) {
	return { mode: profile.mode, url: profile.url ?? "", clientId: profile.clientId ?? "", hasSecret: Boolean(profile.secretCipher) };
}

/** Remote credentials for the main process, or an error message. */
function remoteCredentials(profile, safeStorage) {
	if (profile.mode !== "remote") return { error: "Not in server mode." };
	try {
		const url = normalizeServerURL(profile.url);
		const clientId = normalizeClientId(profile.clientId);
		if (!profile.secretCipher) return { error: "No service token is stored." };
		assertStrongStorage(safeStorage);
		const clientSecret = safeStorage.decryptString(Buffer.from(profile.secretCipher, "base64"));
		if (!clientSecret) return { error: "The stored service token could not be read." };
		return { url, clientId, clientSecret };
	} catch (error) {
		return { error: error?.message ?? String(error) };
	}
}

/** One-time import of a token file (written when the server was set up):
 * {url, clientId, clientSecret}. Saves it encrypted, keeps the current mode,
 * then deletes the plaintext file. Returns true when it imported. */
function importTokenFile(userData, file, safeStorage) {
	let raw;
	try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch { return false; }
	const current = loadProfile(userData);
	saveProfile(userData, { mode: current.mode, url: raw.url, clientId: raw.clientId, secret: raw.clientSecret }, safeStorage);
	fs.rmSync(file, { force: true });
	return true;
}

module.exports = { loadProfile, saveProfile, publicProfile, remoteCredentials, importTokenFile, normalizeServerURL, normalizeClientId, profilePath };
