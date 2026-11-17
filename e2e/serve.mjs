/**
 * Playwright web server (fork: mobile web UI tests). Seeds a throwaway data
 * dir with one synthetic chat, then runs the production build (`npm run build`
 * first) with `next start` on E2E_PORT. Never touches a real profile.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const E2E_CHAT_ID = "chat_mobilee2e_0a1b2c3d";
const port = process.env.E2E_PORT ?? "3197";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
const dataDir = path.join(root, "data");
fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
fs.writeFileSync(path.join(root, "auth.json"), "{}\n", { mode: 0o600 });

const now = Date.now();
const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const long = "Fixed-price contracts move the estimation risk to you. ".repeat(12).trim();
const chat = {
	id: E2E_CHAT_ID,
	title: "Mobile layout check: a deliberately long session title that must truncate",
	createdAt: new Date(now - 60_000).toISOString(),
	updatedAt: new Date(now).toISOString(),
	version: 2,
	settings: { model: { provider: "openrouter", id: "deepseek-v4.1-flash-with-a-long-model-name" }, thinkingLevel: "high" },
	messages: [
		{ id: "m1", role: "user", content: "Explain fixed-price contracts with an example.", timestamp: now - 50_000 },
		{
			id: "m2", role: "assistant", api: "openai-completions", provider: "openrouter", model: "deepseek-v4.1-flash", stopReason: "stop", timestamp: now - 40_000, usage,
			content: [{ type: "text", text: `${long}\n\n\`\`\`ts\nconst estimate = { hours: 300, actual: 500, gapPaidBy: "you", note: "this line is long on purpose so a phone must scroll it inside the code block" };\n\`\`\`\n\nA closing paragraph with a very long word: Donaudampfschifffahrtsgesellschaftskapitänswitwe.` }],
		},
	],
	turns: [],
	tree: { nodes: [], edges: [], version: 1 },
};
fs.writeFileSync(path.join(dataDir, "chats", `${E2E_CHAT_ID}.json`), `${JSON.stringify(chat, null, "\t")}\n`);

const child = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-H", "localhost", "-p", port], {
	stdio: "inherit",
	env: { ...process.env, LH_DATA_DIR: dataDir, LH_AUTH_FILE: path.join(root, "auth.json"), LH_SERVER_MODE: "", NODE_ENV: "production" },
});
const stop = () => { child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true }); };
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("SIGINT", () => { stop(); process.exit(0); });
child.on("exit", (code) => { fs.rmSync(root, { recursive: true, force: true }); process.exit(code ?? 1); });
