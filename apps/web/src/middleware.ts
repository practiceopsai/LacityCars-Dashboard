import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "lacity_session";

/**
 * Gate the dashboard on session-cookie presence. This is UX-level routing
 * only — the API cryptographically verifies the cookie on every request.
 */
export function middleware(req: NextRequest): NextResponse {
  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isLogin = req.nextUrl.pathname === "/login";

  if (!hasSession && !isLogin) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (hasSession && isLogin) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
