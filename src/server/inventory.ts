import { Router, type Request } from "express";
import type pg from "pg";
import { withTenantTx } from "../db.js";
import { currentUser, requireAuth, requireRole } from "./auth.js";
import { getCatalogItem, getCatalogItemsByIds } from "./catalog/index.js";
import { HttpError, badRequest, isUuid, notFound } from "./errors.js";
import { withIdempotency } from "./idempotency.js";

export type Inventory = {
  id: string;
  tenantId: string;
  catalogItemId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  count: number;
  updatedBy: string;
  updatedAt: string;
};

export type Order = {
  id: string;
  inventoryId: string;
  quantity: number;
  status: "PENDING" | "DELIVERED";
  createdAt: string;
};

type InventoryRow = {
  id: string;
  tenantId: string;
  catalogItemId: string;
  count: number;
  updatedBy: string;
  updatedAt: Date;
};

const MAX_QUANTITY = 1000;

function parseQuantity(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
    throw badRequest(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
  }
  return n;
}

function inventoryId(req: Request): string {
  const id = req.params.id;
  // Malformed ids are indistinguishable from ids that don't exist (or belong to another tenant).
  if (!isUuid(id)) throw notFound("Inventory not found");
  return id;
}

/** Inventory rows for the tenant (optionally one id), enriched with catalog data via the catalog service. */
async function loadInventories(client: pg.PoolClient, tenantId: string, id?: string): Promise<Inventory[]> {
  const { rows } = await client.query<InventoryRow>(
    `SELECT inv.id, inv.tenant_id AS "tenantId", inv.catalog_item_id AS "catalogItemId",
            (SELECT count(*)::int FROM inventory_items it
              WHERE it.inventory_id = inv.id AND it.tenant_id = inv.tenant_id AND it.status = 'AVAILABLE') AS count,
            u.email AS "updatedBy", inv.updated_at AS "updatedAt"
       FROM inventories inv
       JOIN users u ON u.id = inv.updated_by
      WHERE inv.tenant_id = $1 AND ($2::uuid IS NULL OR inv.id = $2::uuid)
      ORDER BY inv.updated_at DESC, inv.id`,
    [tenantId, id ?? null],
  );
  const catalog = await getCatalogItemsByIds(rows.map((r) => r.catalogItemId));
  return rows.map((r) => {
    const item = catalog.get(r.catalogItemId);
    return {
      id: r.id,
      tenantId: r.tenantId,
      catalogItemId: r.catalogItemId,
      sku: item?.sku ?? "",
      name: item?.name ?? "Unknown catalog item",
      unitPriceCents: item?.unitPriceCents ?? 0,
      count: r.count,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function loadInventory(client: pg.PoolClient, tenantId: string, id: string): Promise<Inventory> {
  const [inv] = await loadInventories(client, tenantId, id);
  if (!inv) throw notFound("Inventory not found");
  return inv;
}

/** Throws 404 unless the inventory exists for this tenant. */
async function assertInventory(client: pg.PoolClient, tenantId: string, id: string): Promise<void> {
  const { rowCount } = await client.query(`SELECT 1 FROM inventories WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (rowCount === 0) throw notFound("Inventory not found");
}

/**
 * Claims up to `limit` AVAILABLE units with FOR UPDATE SKIP LOCKED and sets them to `status`.
 * Units locked by a concurrent transaction are skipped, not waited on, so concurrent buyers
 * claim disjoint units. limit = null claims every currently claimable unit.
 */
async function claimUnits(
  client: pg.PoolClient,
  tenantId: string,
  inventoryId: string,
  limit: number | null,
  status: "SOLD" | "REMOVED",
  orderId: string | null,
): Promise<number> {
  const { rowCount } = await client.query(
    `WITH picked AS (
       SELECT id FROM inventory_items
        WHERE inventory_id = $1 AND tenant_id = $2 AND status = 'AVAILABLE'
        ORDER BY id LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE inventory_items i SET status = $4::unit_status, order_id = $5
       FROM picked WHERE i.id = picked.id AND i.tenant_id = $2
     RETURNING i.id`,
    [inventoryId, tenantId, limit, status, orderId],
  );
  return rowCount ?? 0;
}

export const inventoryRouter = Router();
inventoryRouter.use("/inventories", requireAuth);

inventoryRouter.get("/inventories", async (req, res) => {
  const user = currentUser(req);
  res.json(await withTenantTx(user.tenantId, (client) => loadInventories(client, user.tenantId)));
});

inventoryRouter.get("/inventories/:id", async (req, res) => {
  const user = currentUser(req);
  const id = inventoryId(req);
  res.json(await withTenantTx(user.tenantId, (client) => loadInventory(client, user.tenantId, id)));
});

// Add stock: upsert the (tenant, catalog item) row, then insert `quantity` AVAILABLE units.
inventoryRouter.post("/inventories", requireRole("admin"), async (req, res) => {
  const user = currentUser(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const quantity = parseQuantity(body.quantity);
  if (typeof body.catalogItemId !== "string") throw badRequest("catalogItemId is required");
  const catalogItem = await getCatalogItem(body.catalogItemId);
  if (!catalogItem) throw badRequest("catalogItemId does not exist in the catalog");

  const result = await withIdempotency(req, user.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO inventories (tenant_id, catalog_item_id, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, catalog_item_id)
         DO UPDATE SET updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id`,
      [user.tenantId, catalogItem.id, user.id],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO inventory_items (inventory_id, tenant_id, added_by)
       SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
      [id, user.tenantId, user.id, quantity],
    );
    return { status: 201, body: await loadInventory(client, user.tenantId, id) };
  });
  res.status(result.status).json(result.body);
});

// Purchase: create the order, then claim units with SKIP LOCKED; short claim -> rollback -> 409.
// Deliberately does not touch the inventories row (updated_by/updated_at track stock changes by
// admins); updating it here would row-lock it and serialize every concurrent buyer.
inventoryRouter.patch("/inventories/:id", requireRole("user", "admin"), async (req, res) => {
  const user = currentUser(req);
  const id = inventoryId(req);
  const quantity = parseQuantity(((req.body ?? {}) as Record<string, unknown>).quantity);

  const result = await withIdempotency(req, user.tenantId, async (client) => {
    await assertInventory(client, user.tenantId, id);
    const { rows } = await client.query<{ id: string; status: Order["status"]; createdAt: Date }>(
      `INSERT INTO orders (tenant_id, inventory_id, user_id, quantity)
       VALUES ($1, $2, $3, $4)
       RETURNING id, status, created_at AS "createdAt"`,
      [user.tenantId, id, user.id, quantity],
    );
    const orderRow = rows[0]!;
    const claimed = await claimUnits(client, user.tenantId, id, quantity, "SOLD", orderRow.id);
    if (claimed < quantity) {
      throw new HttpError(409, "insufficient_stock", `Only ${claimed} of ${quantity} requested units are available`);
    }
    const order: Order = {
      id: orderRow.id,
      inventoryId: id,
      quantity,
      status: orderRow.status,
      createdAt: orderRow.createdAt.toISOString(),
    };
    return { status: 200, body: { inventory: await loadInventory(client, user.tenantId, id), order } };
  });
  res.status(result.status).json(result.body);
});

// Remove stock: same SKIP LOCKED pick, marking units REMOVED. No quantity -> all claimable units.
inventoryRouter.delete("/inventories/:id", requireRole("admin"), async (req, res) => {
  const user = currentUser(req);
  const id = inventoryId(req);
  const raw = req.query.quantity;
  const quantity = raw === undefined ? null : parseQuantity(raw);

  const inventory = await withTenantTx(user.tenantId, async (client) => {
    await assertInventory(client, user.tenantId, id);
    const removed = await claimUnits(client, user.tenantId, id, quantity, "REMOVED", null);
    if (quantity !== null && removed < quantity) {
      throw new HttpError(409, "insufficient_stock", `Only ${removed} of ${quantity} requested units can be removed`);
    }
    await client.query(
      `UPDATE inventories SET updated_by = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [id, user.tenantId, user.id],
    );
    return loadInventory(client, user.tenantId, id);
  });
  res.json(inventory);
});
