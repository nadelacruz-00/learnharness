/**
 * GET /api/whoami (fork: remote server mode). Gated like every other route,
 * so a 200 answer proves that this device passed the Tailscale identity
 * check. The desktop app's "Test connection" uses it after /api/health.
 * Returns only the caller's own login (null outside remote mode).
 */

import { remoteIdentityResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	return remoteIdentityResponse(request);
}
