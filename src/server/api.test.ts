import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { APP_DATABASE_URL, pool } from "../db.js";
import { PASSWORD, createFixtures, ownerClient, setupDatabase, startServer, type Fixtures } from "./test-helpers.js";

let server: Server;
let baseUrl: string;
let owner: pg.Client;
let fx: Fixtures;
const tokens: Record<"adminA" | "userA" | "adminB" | "userB", string> = { adminA: "", userA: "", adminB: "", userB: "" };

type Res = { status: number; body: any };
let keySeq = 0;
const newKey = () => `test-key-${process.pid}-${++keySeq}`;

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; key?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, password = PASSWORD) {
  return call("POST", "/auth/login", { body: { email, password } });
}

async function addStock(token: string, catalogItemId: string, quantity: number) {
  const res = await call("POST", "/inventories", { token, body: { catalogItemId, quantity }, key: newKey() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function assertError(res: Res, status: number, code: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.error?.code, code);
  assert.equal(typeof res.body.error.message, "string");
}

before(async () => {
  await setupDatabase();
  owner = await ownerClient();
  fx = await createFixtures(owner);
  ({ server, baseUrl } = await startServer());
  for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) {
    const res = await login(fx.emails[k]);
    assert.equal(res.status, 200);
    tokens[k] = res.body.token;
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await owner.end();
  await pool.end();
});

describe("auth", () => {
  test("login success returns token and SessionUser", async () => {
    const res = await login(fx.emails.adminA);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, "string");
    assert.deepEqual(Object.keys(res.body.user).sort(), ["email", "id", "role", "tenantId", "tenantName"]);
    assert.equal(res.body.user.role, "admin");
    assert.equal(res.body.user.tenantName, "Tenant A");
    assert.equal(res.body.user.tenantId, fx.tenantA);
  });

  test("login failure is 401", async () => {
    assertError(await login(fx.emails.adminA, "wrong"), 401, "unauthorized");
    assertError(await login("nobody@x.test"), 401, "unauthorized");
    assertError(await call("POST", "/auth/login", { body: {} }), 400, "invalid_request");
  });

  test("me, logout, and token invalidation", async () => {
    const { body } = await login(fx.emails.userB);
    const me = await call("GET", "/auth/me", { token: body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, fx.emails.userB);
    assert.equal(me.body.user.role, "user");
    assert.equal((await call("POST", "/auth/logout", { token: body.token })).status, 204);
    assertError(await call("GET", "/auth/me", { token: body.token }), 401, "unauthorized");
  });

  test("missing/garbage token is 401", async () => {
    assertError(await call("GET", "/inventories"), 401, "unauthorized");
    assertError(await call("GET", "/catalogs", { token: "nope" }), 401, "unauthorized");
  });
});

describe("catalog", () => {
  test("lists catalog items for any role", async () => {
    const res = await call("GET", "/catalogs", { token: tokens.userA });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, fx.catalog.length);
    assert.deepEqual(Object.keys(res.body[0]).sort(), ["description", "id", "name", "sku", "unitPriceCents"]);
  });
});

describe("inventory", () => {
  test("user role gets 403 on POST and DELETE", async () => {
    const inv = await addStock(tokens.adminA, fx.catalog[0]!.id, 3);
    assertError(
      await call("POST", "/inventories", {
        token: tokens.userA,
        body: { catalogItemId: fx.catalog[0]!.id, quantity: 1 },
        key: newKey(),
      }),
      403,
      "forbidden",
    );
    assertError(await call("DELETE", `/inventories/${inv.id}?quantity=1`, { token: tokens.userA }), 403, "forbidden");
  });

  test("validation: quantity, catalogItemId, Idempotency-Key, bad uuid", async () => {
    const catalogItemId = fx.catalog[0]!.id;
    for (const quantity of [0, 1001, 1.5, "abc", null]) {
      assertError(
        await call("POST", "/inventories", { token: tokens.adminA, body: { catalogItemId, quantity }, key: newKey() }),
        400,
        "invalid_request",
      );
    }
    assertError(
      await call("POST", "/inventories", {
        token: tokens.adminA,
        body: { catalogItemId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
        key: newKey(),
      }),
      400,
      "invalid_request",
    );
    assertError(
      await call("POST", "/inventories", { token: tokens.adminA, body: { catalogItemId, quantity: 1 } }),
      400,
      "invalid_request",
    );
    assertError(await call("GET", "/inventories/not-a-uuid", { token: tokens.adminA }), 404, "not_found");
    assertError(await call("DELETE", "/inventories/not-a-uuid", { token: tokens.adminA }), 404, "not_found");
  });

  test("POST twice for the same catalog item adds to one inventory row", async () => {
    const catalogItemId = fx.catalog[1]!.id;
    const first = await addStock(tokens.adminA, catalogItemId, 5);
    const second = await addStock(tokens.adminA, catalogItemId, 7);
    assert.equal(second.id, first.id);
    assert.equal(first.count, 5);
    assert.equal(second.count, 12);
    assert.equal(second.sku, "SKU-2");
    assert.equal(second.unitPriceCents, 200);
    assert.equal(second.updatedBy, fx.emails.adminA);
    const list = await call("GET", "/inventories", { token: tokens.userA });
    assert.equal(list.body.filter((i: any) => i.catalogItemId === catalogItemId).length, 1);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM inventories WHERE tenant_id = $1 AND catalog_item_id = $2`, [
      fx.tenantA,
      catalogItemId,
    ]);
    assert.equal(rows[0].n, 1);
  });

  test("POST replay with same key does not add units twice", async () => {
    const key = newKey();
    const body = { catalogItemId: fx.catalog[2]!.id, quantity: 4 };
    const a = await call("POST", "/inventories", { token: tokens.adminB, body, key });
    const b = await call("POST", "/inventories", { token: tokens.adminB, body, key });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body, a.body);
    const now = await call("GET", `/inventories/${a.body.id}`, { token: tokens.adminB });
    assert.equal(now.body.count, 4);
  });

  test("DELETE removes N units, all when omitted, 409 when short", async () => {
    const inv = await addStock(tokens.adminA, fx.catalog[3]!.id, 6);
    const r1 = await call("DELETE", `/inventories/${inv.id}?quantity=2`, { token: tokens.adminA });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.count, 4);
    assertError(await call("DELETE", `/inventories/${inv.id}?quantity=5`, { token: tokens.adminA }), 409, "insufficient_stock");
    assertError(await call("DELETE", `/inventories/${inv.id}?quantity=0`, { token: tokens.adminA }), 400, "invalid_request");
    const r2 = await call("DELETE", `/inventories/${inv.id}`, { token: tokens.adminA });
    assert.equal(r2.body.count, 0);
    const { rows } = await owner.query(`SELECT status::text, count(*)::int AS n FROM inventory_items WHERE inventory_id = $1 GROUP BY 1`, [
      inv.id,
    ]);
    assert.deepEqual(rows, [{ status: "REMOVED", n: 6 }]);
  });

  test("tenant A cannot GET/PATCH/DELETE tenant B's inventory (404)", async () => {
    const invB = await addStock(tokens.adminB, fx.catalog[0]!.id, 5);
    assertError(await call("GET", `/inventories/${invB.id}`, { token: tokens.adminA }), 404, "not_found");
    assertError(
      await call("PATCH", `/inventories/${invB.id}`, { token: tokens.userA, body: { quantity: 1 }, key: newKey() }),
      404,
      "not_found",
    );
    assertError(await call("DELETE", `/inventories/${invB.id}?quantity=1`, { token: tokens.adminA }), 404, "not_found");
    const listA = await call("GET", "/inventories", { token: tokens.adminA });
    assert.ok(listA.body.every((i: any) => i.tenantId === fx.tenantA));
    assert.ok(!listA.body.some((i: any) => i.id === invB.id));
    // B's stock is untouched.
    const own = await call("GET", `/inventories/${invB.id}`, { token: tokens.userB });
    assert.equal(own.body.count, 5);
  });

  test("RLS backstop: blink_app with tenant A context cannot see tenant B rows", async () => {
    await addStock(tokens.adminB, fx.catalog[4]!.id, 2);
    const app = new pg.Client({ connectionString: APP_DATABASE_URL });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [fx.tenantA]);
      for (const table of ["inventories", "inventory_items", "orders", "idempotency_keys"]) {
        // Deliberately no tenant_id filter: only RLS stands between us and tenant B's rows.
        const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [fx.tenantB]);
        assert.equal(rows[0].n, 0, `${table} leaked tenant B rows`);
      }
      // Writing a row for tenant B is rejected by WITH CHECK.
      await assert.rejects(
        app.query(`INSERT INTO inventories (tenant_id, catalog_item_id, updated_by)
                   SELECT $1, $2, id FROM users LIMIT 1`, [fx.tenantB, fx.catalog[3]!.id]),
        /row-level security/,
      );
      await app.query("ROLLBACK");
      // Without any tenant context, tenant tables look empty.
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM inventories`);
      assert.equal(rows[0].n, 0);
    } finally {
      await app.end();
    }
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM inventories WHERE tenant_id = $1`, [fx.tenantB]);
    assert.ok(rows[0].n > 0, "sanity: tenant B does have rows");
  });

  test("concurrency: 20 concurrent single-unit purchases of 10 units", async () => {
    const { rows: cat } = await owner.query<{ id: string }>(
      `INSERT INTO catalog_items (sku, name, unit_price_cents) VALUES ('SKU-RACE', 'Race item', 1) RETURNING id`,
    );
    const inv = await addStock(tokens.adminA, cat[0]!.id, 10);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call("PATCH", `/inventories/${inv.id}`, {
          token: i % 2 ? tokens.userA : tokens.adminA,
          body: { quantity: 1 },
          key: newKey(),
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 10, JSON.stringify(results.map((r) => r.status)));
    assert.equal(conflicts.length, 10);
    for (const c of conflicts) assert.equal(c.body.error.code, "insufficient_stock");
    assert.equal(new Set(ok.map((r) => r.body.order.id)).size, 10);

    const final = await call("GET", `/inventories/${inv.id}`, { token: tokens.userA });
    assert.equal(final.body.count, 0);

    const { rows: units } = await owner.query<{ status: string; order_id: string | null }>(
      `SELECT status::text, order_id FROM inventory_items WHERE inventory_id = $1`,
      [inv.id],
    );
    assert.equal(units.length, 10);
    assert.ok(units.every((u) => u.status === "SOLD" && u.order_id));
    // Each successful order owns exactly one distinct unit; no unit is shared.
    assert.deepEqual(new Set(units.map((u) => u.order_id)), new Set(ok.map((r) => r.body.order.id)));
    const { rows: orders } = await owner.query(`SELECT count(*)::int AS n FROM orders WHERE inventory_id = $1`, [inv.id]);
    assert.equal(orders[0].n, 10, "failed purchases must not leave orders behind");
  });

  test("PATCH idempotent replay returns same order and decrements once; different body -> 409", async () => {
    const inv = await addStock(tokens.adminA, fx.catalog[4]!.id, 5);
    const key = newKey();
    const a = await call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 2 }, key });
    const b = await call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 2 }, key });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(a.body.inventory.count, 3);
    assert.equal(a.body.order.quantity, 2);
    assert.equal(a.body.order.status, "PENDING");
    assert.equal((await call("GET", `/inventories/${inv.id}`, { token: tokens.userA })).body.count, 3);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM orders WHERE inventory_id = $1`, [inv.id]);
    assert.equal(rows[0].n, 1);

    assertError(
      await call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 1 }, key }),
      409,
      "idempotency_conflict",
    );
    assert.equal((await call("GET", `/inventories/${inv.id}`, { token: tokens.userA })).body.count, 3);
  });

  test("concurrent duplicate PATCHes with one key execute once", async () => {
    const { rows: cat } = await owner.query<{ id: string }>(
      `INSERT INTO catalog_items (sku, name, unit_price_cents) VALUES ('SKU-DUP', 'Dup item', 1) RETURNING id`,
    );
    const inv = await addStock(tokens.adminA, cat[0]!.id, 10);
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 1 }, key }),
      ),
    );
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.order.id)).size, 1);
    assert.equal((await call("GET", `/inventories/${inv.id}`, { token: tokens.userA })).body.count, 9);
  });

  test("failed PATCH (insufficient_stock) does not store the key; retry succeeds after restock", async () => {
    const { rows: cat } = await owner.query<{ id: string }>(
      `INSERT INTO catalog_items (sku, name, unit_price_cents) VALUES ('SKU-RETRY', 'Retry item', 1) RETURNING id`,
    );
    const inv = await addStock(tokens.adminA, cat[0]!.id, 1);
    const key = newKey();
    assertError(
      await call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 3 }, key }),
      409,
      "insufficient_stock",
    );
    assert.equal((await call("GET", `/inventories/${inv.id}`, { token: tokens.userA })).body.count, 1);
    await addStock(tokens.adminA, cat[0]!.id, 5);
    const retry = await call("PATCH", `/inventories/${inv.id}`, { token: tokens.userA, body: { quantity: 3 }, key });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.inventory.count, 3);
  });

  test("unknown routes and malformed JSON use the error shape", async () => {
    assertError(await call("GET", "/nope", { token: tokens.userA }), 404, "not_found");
    const res = await fetch(baseUrl + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_request");
  });
});
