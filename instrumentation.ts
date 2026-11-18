/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Remote server mode (fork): refuse to start with a broken Tailscale
		// setup or a non-loopback bind address.
		const { assertRemoteAccessConfigured } = await import("./src/server/remote-access.ts");
		try { assertRemoteAccessConfigured(); }
		catch (error) {
			// Next would keep the process up and fail every request: exit so the
			// container's restart loop and logs show the cause.
			console.error(`[remote-access] ${(error as Error).message} Refusing to start.`);
			process.exit(1);
		}
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	}
}
