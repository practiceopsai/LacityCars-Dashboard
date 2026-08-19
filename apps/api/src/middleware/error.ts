import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { InvalidTransitionError } from "@lacity/shared";
import { logger } from "../logger";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}`, requestId: req.requestId },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.requestId },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId: req.requestId,
      },
    });
    return;
  }
  if (err instanceof InvalidTransitionError) {
    res.status(409).json({
      error: { code: "INVALID_TRANSITION", message: err.message, requestId: req.requestId },
    });
    return;
  }
  logger.error({ err, requestId: req.requestId, path: req.path }, "Unhandled API error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId: req.requestId },
  });
}
