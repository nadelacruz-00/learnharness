/**
 * Mobile web UI tests (fork). Chromium, Firefox and WebKit (Safari's engine)
 * at phone size, plus one desktop check. Run `npm run build` first, then
 * `npm run test:e2e`. See e2e/mobile.spec.ts.
 */
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3197);

export default defineConfig({
	testDir: "e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [["list"]],
	use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
	webServer: {
		command: "node e2e/serve.mjs",
		url: `http://localhost:${port}/api/health`,
		reuseExistingServer: false,
		timeout: 120_000,
		env: { E2E_PORT: String(port) },
	},
	projects: [
		{ name: "chromium-phone", use: { ...devices["Pixel 7"] }, grepInvert: /@desktop/ },
		// Firefox has no mobile emulation (isMobile); a phone-size viewport still checks the layout.
		{ name: "firefox-phone", use: { browserName: "firefox", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, grepInvert: /@desktop/ },
		{ name: "webkit-phone", use: { ...devices["iPhone 13"] }, grepInvert: /@desktop/ },
		{ name: "chromium-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, grep: /@desktop/ },
	],
});
