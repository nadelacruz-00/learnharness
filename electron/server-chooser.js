"use strict";
// Renderer script for server-chooser.html (no Node, sandboxed).
(async () => {
	const $ = (id) => document.getElementById(id);
	const form = $("form"), remote = $("remote"), status = $("status");
	const say = (text, kind = "") => { status.textContent = text; status.className = kind; };
	const mode = () => form.querySelector("input[name=mode]:checked")?.value ?? "local";
	const input = () => ({ mode: mode(), url: $("url").value });
	const sync = () => { remote.hidden = mode() !== "remote"; };
	const busy = (on) => { for (const id of ["test", "save", "cancel"]) $(id).disabled = on; };

	const state = await window.lhServer.get();
	form.querySelector(`input[name=mode][value=${state.profile.mode === "remote" ? "remote" : "local"}]`).checked = true;
	$("url").value = state.profile.url;
	if (state.notice) say(state.notice, "bad");
	sync();
	form.addEventListener("change", sync);

	$("test").addEventListener("click", async () => {
		busy(true); say("Testing…");
		try {
			const result = await window.lhServer.test(input());
			say(result.ok ? `Connected${result.login ? ` as ${result.login}` : ""}. The server accepts this device.` : result.message, result.ok ? "good" : "bad");
		} catch (error) { say(String(error?.message ?? error), "bad"); }
		finally { busy(false); }
	});
	$("cancel").addEventListener("click", () => window.lhServer.cancel());
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		busy(true); say(mode() === "remote" ? "Checking the server…" : "Saving…");
		try {
			const result = await window.lhServer.save(input());
			if (!result.ok) { say(result.message, "bad"); busy(false); }
			else say("Saved. Restarting…", "good");
		} catch (error) { say(String(error?.message ?? error), "bad"); busy(false); }
	});
})();
