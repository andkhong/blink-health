import pg from "pg";

// The app connects as blink_app (RLS applies). Migrations and seeding use the owner role.
export const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://blink_app:blink_app@localhost:5442/blink";
export const OWNER_DATABASE_URL =
  process.env.OWNER_DATABASE_URL ?? "postgres://blink_owner:blink_owner@localhost:5442/blink";

export const pool = new pg.Pool({ connectionString: APP_DATABASE_URL });

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Runs fn in a transaction with app.tenant_id set, so RLS policies scope every query to tenantId.
// The setting is transaction-local and resets at COMMIT/ROLLBACK.
export function withTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTx(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(client);
  });
}
