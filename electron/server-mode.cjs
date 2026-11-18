"use strict";
/*
 * Desktop server mode (fork: remote server mode): the "LearnHarness Server…"
 * chooser window, its IPC, and "Copy Local Data to Server…". main.cjs owns
 * the boot decision; this module owns everything a user sees about it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { loadProfile, saveProfile, publicProfile, remoteServerFromProfile, normalizeServerURL } = require("./server-profile.cjs");
const { probeServer } = require("./server-probe.cjs");

function createServerMode({ electron, userData, log, localDataDir, archiveModuleCandidates }) {
	const { BrowserWindow, ipcMain, dialog, app } = electron;
	let chooser = null;
	let notice = "";

	const profile = () => loadProfile(userData);
	const remoteServer = () => remoteServerFromProfile(profile());

	const fromChooser = (event) => chooser && !chooser.isDestroyed() && event.sender === chooser.webContents;

	function registerIPC() {
		ipcMain.handle("lh:server:get", (event) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			return { profile: publicProfile(profile()), notice };
		});
		ipcMain.handle("lh:server:test", async (event, input) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			try {
				return await probeServer(normalizeServerURL(input?.url));
			} catch (error) {
				return { ok: false, reason: "input", message: error?.message ?? String(error) };
			}
		});
		ipcMain.handle("lh:server:save", async (event, input) => {
			if (!fromChooser(event)) throw new Error("Untrusted request.");
			try {
				if (input?.mode === "remote") {
					const probe = await probeServer(normalizeServerURL(input?.url));
					if (!probe.ok) return probe;
				}
				saveProfile(userData, input);
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
			width: 600, height: 600, title: "LearnHarness server", autoHideMenuBar: true, show: false,
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

	// No credentials: `tailscale serve` adds this device's Tailscale identity.
	async function postArchive(url, archive, replace) {
		return fetch(`${url}/api/data/import${replace ? "?replace=1" : ""}`, {
			method: "POST",
			headers: { "Content-Type": "application/gzip" },
			body: archive,
			redirect: "manual",
		});
	}

	/** Menu: copies this computer's learning data to the configured server.
	 * Secrets (API keys, subscription logins) are never copied. */
	async function copyLocalDataToServer(parent) {
		const server = remoteServer();
		const show = (type, message, detail) => dialog.showMessageBox(parent, { type, message, detail, buttons: ["OK"] });
		if (server.error) {
			await show("info", "Set up the server first", "Open LearnHarness Server… and enter the server's tailnet address. You can stay in local mode.");
			return;
		}
		let chats = 0;
		try { chats = fs.readdirSync(path.join(localDataDir, "chats")).filter((name) => name.endsWith(".json")).length; } catch { /* none */ }
		const confirm = await dialog.showMessageBox(parent, {
			type: "question", buttons: ["Copy", "Cancel"], defaultId: 1, cancelId: 1,
			message: `Copy local learning data to ${server.url}?`,
			detail: `${chats} chat${chats === 1 ? "" : "s"}, the knowledge graph, settings and plugin data from ${localDataDir}.\n\nAPI keys and logins are not copied. Plugin data and code will run on the server.`,
		});
		if (confirm.response !== 0) return;
		try {
			const { createArchive } = await loadArchiveModule();
			const archive = createArchive(localDataDir);
			let response = await postArchive(server.url, archive, false);
			let body = await response.json().catch(() => ({}));
			if (response.status === 409 && body?.error === "server_has_data") {
				const replace = await dialog.showMessageBox(parent, {
					type: "warning", buttons: ["Replace server data", "Cancel"], defaultId: 1, cancelId: 1,
					message: `The server already has ${body.chats ?? "some"} chats.`,
					detail: "Replace them with the data from this computer? The server saves a backup of its current data first.",
				});
				if (replace.response !== 0) return;
				response = await postArchive(server.url, archive, true);
				body = await response.json().catch(() => ({}));
			}
			if (!response.ok || !body?.ok) {
				await show("error", "The copy failed.", body?.message ?? body?.error ?? `HTTP ${response.status}`);
				return;
			}
			log(`server mode: copied ${body.files} files (${body.chats} chats) to ${server.url}; backup ${body.backup ?? "none"}`);
			await show("info", "Your data is on the server.", `${body.chats} chats and ${body.files} files copied.${body.backup ? ` The server's old data is backed up in ${body.backup}.` : ""}`);
		} catch (error) {
			await show("error", "The copy failed.", error?.message ?? String(error));
		}
	}

	return { profile, remoteServer, registerIPC, openChooser, copyLocalDataToServer };
}

module.exports = { createServerMode };
