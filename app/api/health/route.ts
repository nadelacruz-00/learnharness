/** Liveness probe for containers and the desktop app's "Test connection".
 * Returns no learning data, so it is open in every mode. */
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export function HEAD() {
	return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
