import type { NextFunction, Request, Response } from "express";
import { CSRF_HEADER, CSRF_HEADER_VALUE, SESSION_COOKIE } from "@lacity/shared";
import type { ApiConfig } from "../config";
import { verifySessionToken } from "../services/session";
import { HttpError } from "./error";

/** Parse the session cookie without a cookie-parser dependency. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Operator session guard for dashboard routes. */
export function requireSession(config: ApiConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readSessionCookie(req);
    if (!verifySessionToken(token, config.SESSION_SECRET)) {
      next(new HttpError(401, "UNAUTHENTICATED", "Operator session required"));
      return;
    }
    next();
  };
}

/**
 * CSRF defense-in-depth for cookie-authenticated mutations: the SameSite=Lax
 * cookie already blocks cross-site POSTs; additionally require a custom header
 * that simple cross-site form submissions cannot set.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction): void {
  const value = req.headers[CSRF_HEADER];
  if (value !== CSRF_HEADER_VALUE) {
    next(new HttpError(403, "CSRF_HEADER_MISSING", `Mutations require the ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} header`));
    return;
  }
  next();
}
