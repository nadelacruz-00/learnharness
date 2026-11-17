/**
 * POST /api/data/import[?replace=1] — REPLACE the server's data folder with
 * an uploaded tar.gz (raw body, or the multipart field "file"). The route
 * caps it at 256 MB, but Next's Proxy cuts bodies above 26 MiB first
 * (next.config.ts proxyClientMaxBodySize): a cut upload gets 400 truncated. 409 when the server already has chats and replace=1 is absent,
 * and while any turn is running. The old data folder moves to
 * <parent of data dir>/backups/<timestamp>/ first; the auth file is never
 * read or written. Logic: src/server/data-transfer.ts.
 */

import { dataImportResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
	return dataImportResponse(request);
}
