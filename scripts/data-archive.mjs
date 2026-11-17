#!/usr/bin/env node
/**
 * data-archive.mjs — move LearnHarness data without the server running.
 * The CLI fallback for GET /api/data/export and POST /api/data/import; it
 * uses the same module (src/server/data-archive.mjs), so the rules match.
 *
 *   node scripts/data-archive.mjs export <dataDir> <out.tar.gz>
 *   node scripts/data-archive.mjs import <in.tar.gz> <dataDir>
 *
 * Export leaves out debug/ and credential-like files (auth.json*,
 * *-credentials.json*, .env*). Import REPLACES <dataDir>: the old folder
 * moves to <parent of dataDir>/backups/<timestamp>/ first, and credential
 * files in it move into the new data dir by rename (never read). Stop the
 * server before an import: this CLI cannot see running turns.
 */
import fs from "node:fs";
import path from "node:path";
import { createArchive, importArchive, DataArchiveError } from "../src/server/data-archive.mjs";

const USAGE = "usage: node scripts/data-archive.mjs export <dataDir> <out.tar.gz> | import <in.tar.gz> <dataDir>";

function main(argv) {
	const [command, first, second] = argv;
	if (!first || !second || argv.length !== 3) throw new DataArchiveError("usage", USAGE);
	if (command === "export") {
		const archive = createArchive(first);
		const out = path.resolve(second);
		fs.writeFileSync(out, archive, { flag: "wx", mode: 0o600 }); // never overwrite an existing file
		console.log(`Exported ${path.resolve(first)} to ${out} (${archive.length} bytes).`);
		return;
	}
	if (command === "import") {
		const result = importArchive(fs.readFileSync(first), second);
		console.log(`Imported ${result.files} files (${result.chats} chats) into ${path.resolve(second)}.`);
		console.log(result.backup ? `Old data moved to ${result.backup}.` : "There was no old data dir, so no backup was made.");
		if (result.skipped.length) console.log(`Skipped credential-like entries: ${result.skipped.join(", ")}`);
		return;
	}
	throw new DataArchiveError("usage", USAGE);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(`[data-archive] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
