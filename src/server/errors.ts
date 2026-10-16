import type { ErrorRequestHandler, RequestHandler } from "express";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "insufficient_stock"
  | "idempotency_conflict"
  | "internal_error";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "invalid_request", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(errorBody("not_found", "Route not found"));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(errorBody(err.code, err.message));
    return;
  }
  // body-parser errors (malformed JSON, too large) carry a 4xx status.
  if (err && typeof err === "object" && "type" in err && typeof err.status === "number" && err.status < 500) {
    res.status(400).json(errorBody("invalid_request", "Malformed request body"));
    return;
  }
  console.error(err);
  res.status(500).json(errorBody("internal_error", "Internal server error"));
};
