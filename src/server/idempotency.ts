import { createHash } from "node:crypto";
import type { Request } from "express";
import type pg from "pg";
import { withTenantTx } from "../db.js";
import { HttpError, badRequest } from "./errors.js";

/*
 * Idempotency-Key handling.
 *
 * Everything — claiming the key, doing the work, storing the response — happens in ONE
 * withTenantTx transaction:
 *
 *   1. INSERT a placeholder row (status_code 0) ... ON CONFLICT DO NOTHING RETURNING.
 *      - If the insert wins, this request owns the key. A concurrent duplicate's INSERT blocks
 *        on the primary-key index until we COMMIT or ROLLBACK, so duplicates never both execute.
 *      - If it conflicts, the key was already committed by an earlier request (or the concurrent
 *        owner just committed): SELECT it. Same request_hash -> replay the stored status/body;
 *        different hash -> 409 idempotency_conflict.
 *   2. Run the handler with the same client.
 *   3. UPDATE the placeholder with the real status_code and response_json, then COMMIT.
 *
 * Failures are NOT stored: any thrown error (409 insufficient_stock, 404, 500, ...) rolls back the
 * whole transaction, including the placeholder, so the client may retry with the same key
 * (e.g. after stock is replenished). Only successful responses are replayed. Validation (400)
 * happens before the key is touched and is never stored either.
 *
 * request_hash = sha256(method + " " + path + "\n" + canonical JSON body) — so the same key on a
 * different inventory id, or with a different quantity, is a conflict.
 */

const MAX_KEY_LENGTH = 255;

export type HandlerResult = { status: number; body: unknown };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(req: Request): string {
  return createHash("sha256")
    .update(`${req.method} ${req.baseUrl}${req.path}\n${canonicalJson(req.body ?? null)}`)
    .digest("hex");
}

export function idempotencyKey(req: Request): string {
  const key = req.get("idempotency-key")?.trim();
  if (!key) throw badRequest("Idempotency-Key header is required");
  if (key.length > MAX_KEY_LENGTH) throw badRequest(`Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
  return key;
}

export function withIdempotency(
  req: Request,
  tenantId: string,
  handler: (client: pg.PoolClient) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const key = idempotencyKey(req);
  const hash = requestHash(req);
  return withTenantTx(tenantId, async (client) => {
    const claimed = await client.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response_json)
       VALUES ($1, $2, $3, 0, '{}'::jsonb)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [tenantId, key, hash],
    );

    if (claimed.rowCount === 0) {
      const { rows } = await client.query<{ request_hash: string; status_code: number; response_json: unknown }>(
        `SELECT request_hash, status_code, response_json
           FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
        [tenantId, key],
      );
      const existing = rows[0];
      // Can't normally be missing/placeholder: the owner's row only becomes visible on COMMIT,
      // by which point it holds the final response. Guard anyway.
      if (!existing || existing.status_code === 0) {
        throw new HttpError(409, "idempotency_conflict", "A request with this Idempotency-Key is in progress");
      }
      if (existing.request_hash !== hash) {
        throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used with a different request");
      }
      return { status: existing.status_code, body: existing.response_json };
    }

    const result = await handler(client);
    await client.query(
      `UPDATE idempotency_keys SET status_code = $3, response_json = $4::jsonb
        WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key, result.status, JSON.stringify(result.body)],
    );
    return result;
  });
}
