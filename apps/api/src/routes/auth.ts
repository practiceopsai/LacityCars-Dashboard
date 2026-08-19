import { Router } from "express";
import { z } from "zod";
import { SESSION_COOKIE } from "@lacity/shared";
import type { ApiConfig } from "../config";
import { isProduction } from "../config";
import { HttpError } from "../middleware/error";
import { readSessionCookie } from "../middleware/auth";
import { issueSessionToken, passwordsMatch, verifySessionToken } from "../services/session";

const LoginSchema = z.object({ password: z.string().min(1) });

export function authRouter(config: ApiConfig): Router {
  const router = Router();
  const ttlMs = config.SESSION_TTL_HOURS * 60 * 60 * 1000;

  const cookieOptions = () =>
    [
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(ttlMs / 1000)}`,
      ...(isProduction(config) ? ["Secure"] : []),
    ].join("; ");

  router.post("/login", (req, res, next) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, "VALIDATION_ERROR", "Password is required"));
      return;
    }
    if (!passwordsMatch(parsed.data.password, config.OPERATOR_PASSWORD)) {
      next(new HttpError(401, "INVALID_CREDENTIALS", "Incorrect password"));
      return;
    }
    const token = issueSessionToken(config.SESSION_SECRET, ttlMs);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`);
    res.json({ authenticated: true });
  });

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ authenticated: false });
  });

  router.get("/me", (req, res) => {
    const token = readSessionCookie(req);
    res.json({ authenticated: verifySessionToken(token, config.SESSION_SECRET) });
  });

  return router;
}
