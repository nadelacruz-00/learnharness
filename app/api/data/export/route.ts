/**
 * GET /api/data/export — the server's data folder (PATHS.data) as a tar.gz
 * attachment, for moving data to another server. Leaves out debug/ and
 * credential-like files. 409 while any turn is running.
 * Logic: src/server/data-transfer.ts; format: src/server/data-archive.mjs.
 */

import { dataExportResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return dataExportResponse();
}
