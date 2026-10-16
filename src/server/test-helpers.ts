// Test-only helpers. The `test` npm script points DATABASE_URL / OWNER_DATABASE_URL at blink_test
// before anything imports src/db.ts, so tests never touch the main `blink` database.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { APP_DATABASE_URL, OWNER_DATABASE_URL } from "../db.js";
import { migrate } from "../migrate.js";
import { hashPassword } from "../password.js";
import { createApp } from "./app.js";

export const PASSWORD = "password123";

function assertTestDb(url: string) {
  if (new URL(url).pathname !== "/blink_test") {
    throw new Error(`Refusing to run tests against ${url}; expected database blink_test (use npm test)`);
  }
}

export async function setupDatabase(): Promise<void> {
  assertTestDb(OWNER_DATABASE_URL);
  assertTestDb(APP_DATABASE_URL);
  const adminUrl = new URL(OWNER_DATABASE_URL);
  adminUrl.pathname = "/blink";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'blink_test'`);
    if (rowCount === 0) await admin.query(`CREATE DATABASE blink_test`);
  } finally {
    await admin.end();
  }
  await migrate();
}

export async function ownerClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: OWNER_DATABASE_URL });
  await client.connect();
  return client;
}

export type Fixtures = {
  tenantA: string;
  tenantB: string;
  catalog: { id: string; sku: string }[];
  emails: { adminA: string; userA: string; adminB: string; userB: string };
};

export async function createFixtures(owner: pg.Client): Promise<Fixtures> {
  const hash = hashPassword(PASSWORD);
  const tenant = async (name: string) =>
    (await owner.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name])).rows[0]!.id;
  const tenantA = await tenant("Tenant A");
  const tenantB = await tenant("Tenant B");
  const emails = { adminA: "admin@a.test", userA: "user@a.test", adminB: "admin@b.test", userB: "user@b.test" };
  const users: [string, string, number][] = [
    [emails.adminA, tenantA, 2],
    [emails.userA, tenantA, 1],
    [emails.adminB, tenantB, 2],
    [emails.userB, tenantB, 1],
  ];
  for (const [email, tenantId, roleId] of users) {
    await owner.query(`INSERT INTO users (email, password_hash, tenant_id, role_id) VALUES ($1, $2, $3, $4)`, [
      email,
      hash,
      tenantId,
      roleId,
    ]);
  }
  const catalog: { id: string; sku: string }[] = [];
  for (let i = 1; i <= 5; i++) {
    const { rows } = await owner.query<{ id: string; sku: string }>(
      `INSERT INTO catalog_items (sku, name, description, unit_price_cents) VALUES ($1, $2, '', $3) RETURNING id, sku`,
      [`SKU-${i}`, `Item ${i}`, i * 100],
    );
    catalog.push(rows[0]!);
  }
  return { tenantA, tenantB, catalog, emails };
}

export async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/api` };
}
