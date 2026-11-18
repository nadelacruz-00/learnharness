"use strict";
// Bridge for electron/server-chooser.html only (fork: remote server mode).
// Only the mode and the server address go main-ward; there is no secret.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhServer", {
	get: () => ipcRenderer.invoke("lh:server:get"),
	test: (input) => ipcRenderer.invoke("lh:server:test", input),
	save: (input) => ipcRenderer.invoke("lh:server:save", input),
	cancel: () => ipcRenderer.send("lh:server:cancel"),
});
