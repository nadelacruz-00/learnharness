"use strict";
/*
 * Desktop server mode (fork: remote server mode): the "LearnHarness Server…"
 * chooser window, its IPC, and "Copy Local Data to Server…". main.cjs owns
 * the boot decision; this module owns everything a user sees about it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { loadProfile, saveProfile, publicProfile, remoteCredentials, importTokenFile, normalizeServerURL, normalizeClientId } = require("./server-profile.cjs");
const { probeServer } = require("./remote-headers.cjs");

function createServerMode({ electron, userData, log, tokenFile, localDataDir, archiveModuleCandidates }) {
	const { BrowserWindow, ipcMain, dialog, app } = electron;
	// Only the service token uses the OS keyring (ChatGPT logins keep their
	// private-file store in main.cjs).
	const safeStorage = electron.safeStorage ?? require("electron").safeStorage;
	let chooser = null;
	let notice = "";

	/** One-time import of the token file written during server setup. */
	function importToken() {
		if (!tokenFile || !fs.existsSync(tokenFile)) return;
		try {
			if (importTokenFile(userData, tokenFile, safeStorage)) log(`server mode: imported the service token from ${tokenFile} (plaintext file deleted)`);
		} catch (error) {
			log(`server mode: token import failed: ${error?.message ?? error}`);
			notice = `The service token file could not be imported: ${error?.message ?? error}`;
		}
	}

	const profile = () => loadProfile(userData);
	const credentials = () => remoteCredentials(profile(), safeStorage);

	/** Credentials from the chooser form; an empty secret means "the stored one". */
	function formCredentials(input) {
		const url = normalizeServerURL(input?.url);
		const clientId = normalizeClientId(input?.clientId);
		const typed = typeof input?.secret === "string" ? input.secret.trim() : "";
		if (typed) return { url, clientId, clientSecret: typed };
		const stored = remoteCredentials({ ...profile(), mode: "remote", url, clientId }, safeStorage);
		if (stored.error) throw new Error(stored.error === "No service token is stored." ? "Enter the Cloudflare Access client secret." : stored.error);
		return stored;
	}

	const fromChooser = (event) => chooser && !chooser.isDestroyed() && event.sender === chooser.webContents;

	function registerIPC() {
		ipcMain.handle("lh:server:get", (event) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			return { profile: publicProfile(profile()), notice };
		});
		ipcMain.handle("lh:server:test", async (event, input) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			try {
				const creds = formCredentials(input);
				return await probeServer(creds.url, creds);
			} catch (error) {
				return { ok: false, reason: "input", message: error?.message ?? String(error) };
			}
		});
		ipcMain.handle("lh:server:save", async (event, input) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			try {
				if (input?.mode === "remote") {
					const creds = formCredentials(input);
					const probe = await probeServer(creds.url, creds);
					if (!probe.ok) return probe;
				}
				saveProfile(userData, input, safeStorage);
				log(`server mode: saved mode=${input?.mode === "remote" ? "remote" : "local"}; restarting`);
				setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
				return { ok: true };
			} catch (error) {
				return { ok: false, reason: "input", message: error?.message ?? String(error) };
			}
		});
		ipcMain.on("lh:server:cancel", (event) => {
			if (fromChooser(event)) chooser.close();
		});
	}

	/** Opens the chooser. Resolves when it closes. */
	function openChooser(message = "") {
		notice = message;
		if (chooser && !chooser.isDestroyed()) { chooser.focus(); return new Promise((resolve) => chooser.once("closed", resolve)); }
		chooser = new BrowserWindow({
			width: 600, height: 720, title: "LearnHarness server", autoHideMenuBar: true, show: false,
			webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "server-chooser-preload.cjs") },
		});
		const page = pathToFileURL(path.join(__dirname, "server-chooser.html")).href;
		chooser.webContents.on("will-navigate", (event, target) => { if (target !== page) event.preventDefault(); });
		chooser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		void chooser.loadURL(page);
		chooser.once("ready-to-show", () => chooser.show());
		return new Promise((resolve) => chooser.once("closed", () => { chooser = null; resolve(); }));
	}

	async function loadArchiveModule() {
		for (const candidate of archiveModuleCandidates) {
			if (fs.existsSync(candidate)) return import(pathToFileURL(candidate).href);
		}
		throw new Error("The data archive module is missing from this build.");
	}

	async function postArchive(url, creds, archive, replace) {
		return fetch(`${url}/api/data/import${replace ? "?replace=1" : ""}`, {
			method: "POST",
			headers: { "Content-Type": "application/gzip", "CF-Access-Client-Id": creds.clientId, "CF-Access-Client-Secret": creds.clientSecret },
			body: archive,
			redirect: "manual",
		});
	}

	/** Menu: copies this computer's learning data to the configured server.
	 * Secrets (API keys, subscription logins) are never copied. */
	async function copyLocalDataToServer(parent) {
		const creds = credentials();
		const show = (type, message, detail) => dialog.showMessageBox(parent, { type, message, detail, buttons: ["OK"] });
		if (creds.error) {
			await show("info", "Set up the server first", "Open LearnHarness Server… and enter the server address and service token. You can stay in local mode.");
			return;
		}
		let chats = 0;
		try { chats = fs.readdirSync(path.join(localDataDir, "chats")).filter((name) => name.endsWith(".json")).length; } catch { /* none */ }
		const confirm = await dialog.showMessageBox(parent, {
			type: "question", buttons: ["Copy", "Cancel"], defaultId: 1, cancelId: 1,
			message: `Copy local learning data to ${creds.url}?`,
			detail: `${chats} chat${chats === 1 ? "" : "s"}, the knowledge graph, settings and plugin data from ${localDataDir}.\n\nAPI keys and logins are not copied. Plugin data and code will run on the server.`,
		});
		if (confirm.response !== 0) return;
		try {
			const { createArchive } = await loadArchiveModule();
			const archive = createArchive(localDataDir);
			let response = await postArchive(creds.url, creds, archive, false);
			let body = await response.json().catch(() => ({}));
			if (response.status === 409 && body?.error === "server_has_data") {
				const replace = await dialog.showMessageBox(parent, {
					type: "warning", buttons: ["Replace server data", "Cancel"], defaultId: 1, cancelId: 1,
					message: `The server already has ${body.chats ?? "some"} chats.`,
					detail: "Replace them with the data from this computer? The server saves a backup of its current data first.",
				});
				if (replace.response !== 0) return;
				response = await postArchive(creds.url, creds, archive, true);
				body = await response.json().catch(() => ({}));
			}
			if (!response.ok || !body?.ok) {
				await show("error", "The copy failed.", body?.message ?? body?.error ?? `HTTP ${response.status}`);
				return;
			}
			log(`server mode: copied ${body.files} files (${body.chats} chats) to ${creds.url}; backup ${body.backup ?? "none"}`);
			await show("info", "Your data is on the server.", `${body.chats} chats and ${body.files} files copied.${body.backup ? ` The server's old data is backed up in ${body.backup}.` : ""}`);
		} catch (error) {
			await show("error", "The copy failed.", error?.message ?? String(error));
		}
	}

	return { importToken, profile, credentials, registerIPC, openChooser, copyLocalDataToServer };
}

module.exports = { createServerMode };
