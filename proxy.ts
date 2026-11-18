import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { remoteAccessRefusal, remoteMode } from "./src/server/remote-access.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function isAPIPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability.
 *
 * Remote server mode (fork): pages are gated too, by the Tailscale identity
 * header from `tailscale serve`, because pages render learning data on the
 * server. Local modes keep their /api-only policy. */
export function proxy(request: NextRequest): NextResponse {
	if (remoteMode()) return remoteProxy(request);
	return localProxy(request);
}

function localProxy(request: NextRequest): NextResponse {
	if (!isAPIPath(request.nextUrl.pathname)) return NextResponse.next();
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json({ error: refusal }, { status: 403, headers: NO_STORE });
	}
	return NextResponse.next();
}

function remoteProxy(request: NextRequest): NextResponse {
	const refusal = remoteAccessRefusal(request);
	if (refusal) {
		if (isAPIPath(request.nextUrl.pathname)) return NextResponse.json({ error: refusal }, { status: 403, headers: NO_STORE });
		return new NextResponse(refusal, { status: 403, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
	}
	return localProxy(request);
}

export const config = {
	// Every path except static build assets, the health probe and the one
	// streamed document route (which runs the same checks in its handler).
	// Local modes ignore non-API paths inside proxy(). Must remain static literals.
	matcher: ["/((?!_next/static/|_next/image|favicon\\.ico$|api/health$|api/plugins/[^/]+/documents/markdown/?$).*)"],
};
