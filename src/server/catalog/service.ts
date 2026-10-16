// "External catalog service". Inventory code must go through these functions instead of
// querying catalog_items itself, so the catalog could later be swapped for a real HTTP service.
// Uses the plain pool (catalog is global, not tenant-scoped).
import { pool } from "../../db.js";
import { isUuid } from "../errors.js";

export type CatalogItem = {
  id: string;
  sku: string;
  name: string;
  description: string;
  unitPriceCents: number;
};

const COLUMNS = `id, sku, name, description, unit_price_cents AS "unitPriceCents"`;

export async function listCatalogItems(): Promise<CatalogItem[]> {
  const { rows } = await pool.query<CatalogItem>(`SELECT ${COLUMNS} FROM catalog_items ORDER BY name, sku`);
  return rows;
}

export async function getCatalogItem(id: string): Promise<CatalogItem | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<CatalogItem>(`SELECT ${COLUMNS} FROM catalog_items WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getCatalogItemsByIds(ids: string[]): Promise<Map<string, CatalogItem>> {
  const unique = [...new Set(ids)].filter(isUuid);
  if (unique.length === 0) return new Map();
  const { rows } = await pool.query<CatalogItem>(
    `SELECT ${COLUMNS} FROM catalog_items WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
