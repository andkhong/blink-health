import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler } from "express";
import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "../password.js";
import { HttpError, badRequest } from "./errors.js";

export type Role = "user" | "admin";
export type SessionUser = { id: string; email: string; tenantId: string; tenantName: string; role: Role };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      tokenHash?: string;
    }
  }
}

const SESSION_TTL_HOURS = 12;

// Only a sha256 of the bearer token is stored, so a leaked sessions table can't be replayed.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Used to spend the same scrypt time for unknown emails (avoids a user-enumeration timing oracle).
const DUMMY_HASH = hashPassword("not-a-real-password");

const unauthorized = () => new HttpError(401, "unauthorized", "Authentication required");

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw unauthorized();
  const tokenHash = hashToken(match[1]!);
  const { rows } = await pool.query<SessionUser>(
    `SELECT u.id, u.email, u.tenant_id AS "tenantId", t.name AS "tenantName", r.type::text AS role
       FROM sessions s
       JOIN users u   ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
       JOIN roles r   ON r.id = u.role_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (!rows[0]) throw unauthorized();
  req.user = rows[0];
  req.tokenHash = tokenHash;
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = currentUser(req);
    if (!roles.includes(user.role)) throw new HttpError(403, "forbidden", "Insufficient role");
    next();
  };
}

export const authRouter = Router();

authRouter.post("/auth/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    throw badRequest("email and password are required");
  }
  const { rows } = await pool.query<SessionUser & { passwordHash: string }>(
    `SELECT u.id, u.email, u.tenant_id AS "tenantId", t.name AS "tenantName", r.type::text AS role,
            u.password_hash AS "passwordHash"
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       JOIN roles r   ON r.id = u.role_id
      WHERE lower(u.email) = lower($1)`,
    [email.trim()],
  );
  const row = rows[0];
  const ok = verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, "unauthorized", "Invalid email or password");

  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), row.id, SESSION_TTL_HOURS],
  );
  const { passwordHash: _omit, ...user } = row;
  res.json({ token, user });
});

authRouter.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});

authRouter.post("/auth/logout", requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [req.tokenHash]);
  res.status(204).end();
});
