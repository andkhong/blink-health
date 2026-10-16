import pg from "pg";
import { OWNER_DATABASE_URL } from "./db.js";
import { hashPassword } from "./password.js";

// Seeds demo data. Connects as the owner (bypasses RLS). Truncates tenant data first,
// so it is safe to re-run; `npm run db:reset` rebuilds the schema and seeds from scratch.

const PASSWORD = "password123";
const USER_ROLE = 1;
const ADMIN_ROLE = 2;

type CatalogSeed = { sku: string; name: string; description: string; priceCents: number };

const CATALOG: CatalogSeed[] = [
  { sku: "IBU-200-100", name: "Ibuprofen 200mg, 100 ct", description: "Pain reliever / fever reducer (NSAID) coated tablets.", priceCents: 899 },
  { sku: "APAP-500-100", name: "Acetaminophen 500mg, 100 ct", description: "Extra strength pain reliever caplets.", priceCents: 1049 },
  { sku: "LORA-10-30", name: "Loratadine 10mg, 30 ct", description: "Non-drowsy 24-hour allergy relief tablets.", priceCents: 1599 },
  { sku: "CETI-10-45", name: "Cetirizine 10mg, 45 ct", description: "24-hour indoor & outdoor allergy relief tablets.", priceCents: 2199 },
  { sku: "OMEP-20-42", name: "Omeprazole 20mg, 42 ct", description: "Delayed-release acid reducer, treats frequent heartburn.", priceCents: 2499 },
  { sku: "DPH-25-24", name: "Diphenhydramine 25mg, 24 ct", description: "Antihistamine for allergy relief and occasional sleeplessness.", priceCents: 549 },
  { sku: "ASA-81-120", name: "Low Dose Aspirin 81mg, 120 ct", description: "Enteric coated aspirin tablets.", priceCents: 699 },
  { sku: "VITD3-2000-100", name: "Vitamin D3 2000 IU, 100 ct", description: "Dietary supplement softgels supporting bone health.", priceCents: 1299 },
  { sku: "BAND-ASST-100", name: "Adhesive Bandages, Assorted, 100 ct", description: "Flexible fabric bandages in assorted sizes.", priceCents: 649 },
  { sku: "THERM-DIG-1", name: "Digital Thermometer", description: "Oral/underarm digital thermometer with 10-second reading.", priceCents: 1199 },
  { sku: "SAL-SPRAY-45", name: "Saline Nasal Spray, 1.5 fl oz", description: "Drug-free moisturizing nasal mist.", priceCents: 449 },
  { sku: "NIT-GUM-4-100", name: "Nicotine Gum 4mg, 100 ct", description: "Stop-smoking aid, mint flavor.", priceCents: 4599 },
];

// Units per SKU for each tenant. SKUs not listed are unstocked for that tenant.
// SAL-SPRAY-45 and NIT-GUM-4-100 are stocked by nobody, so admins have something to add.
type TenantSeed = {
  name: string;
  domain: string;
  stock: Record<string, number>;
  orders: { sku: string; quantity: number; status: "PENDING" | "DELIVERED" }[];
};

const TENANTS: TenantSeed[] = [
  {
    name: "CVS",
    domain: "cvs.test",
    stock: {
      "IBU-200-100": 48,
      "APAP-500-100": 35,
      "LORA-10-30": 22,
      "OMEP-20-42": 2, // low stock: easy double-checkout testing
      "ASA-81-120": 60,
      "VITD3-2000-100": 15,
      "BAND-ASST-100": 30,
    },
    orders: [
      { sku: "IBU-200-100", quantity: 3, status: "DELIVERED" },
      { sku: "LORA-10-30", quantity: 2, status: "PENDING" },
    ],
  },
  {
    name: "Walgreens",
    domain: "walgreens.test",
    stock: {
      "IBU-200-100": 25,
      "APAP-500-100": 12,
      "CETI-10-45": 40,
      "DPH-25-24": 1, // low stock
      "VITD3-2000-100": 55,
      "THERM-DIG-1": 8,
    },
    orders: [
      { sku: "CETI-10-45", quantity: 4, status: "DELIVERED" },
      { sku: "THERM-DIG-1", quantity: 1, status: "PENDING" },
    ],
  },
];

async function seed(): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `TRUNCATE idempotency_keys, inventory_items, orders, inventories, sessions, users, tenants, catalog_items
       RESTART IDENTITY CASCADE`,
    );

    const catalogIds = new Map<string, string>();
    for (const c of CATALOG) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO catalog_items (sku, name, description, unit_price_cents)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [c.sku, c.name, c.description, c.priceCents],
      );
      catalogIds.set(c.sku, rows[0]!.id);
    }

    const passwordHash = hashPassword(PASSWORD);
    const summary: { tenant: string; tenantId: string; lines: string[] }[] = [];

    for (const t of TENANTS) {
      const { rows: tenantRows } = await client.query<{ id: string }>(
        "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
        [t.name],
      );
      const tenantId = tenantRows[0]!.id;

      const insertUser = async (email: string, roleId: number): Promise<string> => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, tenant_id, role_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [email, passwordHash, tenantId, roleId],
        );
        return rows[0]!.id;
      };
      const adminId = await insertUser(`admin@${t.domain}`, ADMIN_ROLE);
      const userId = await insertUser(`user@${t.domain}`, USER_ROLE);

      const inventoryIds = new Map<string, string>();
      for (const [sku, units] of Object.entries(t.stock)) {
        const catalogId = catalogIds.get(sku);
        if (!catalogId) throw new Error(`unknown SKU in seed: ${sku}`);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO inventories (tenant_id, catalog_item_id, updated_by)
           VALUES ($1, $2, $3) RETURNING id`,
          [tenantId, catalogId, adminId],
        );
        const inventoryId = rows[0]!.id;
        inventoryIds.set(sku, inventoryId);

        // Orders below are sold out of these units, so add them on top of the target stock.
        const sold = t.orders.filter((o) => o.sku === sku).reduce((n, o) => n + o.quantity, 0);
        await client.query(
          `INSERT INTO inventory_items (inventory_id, tenant_id, added_by)
           SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
          [inventoryId, tenantId, adminId, units + sold],
        );
      }

      for (const o of t.orders) {
        const inventoryId = inventoryIds.get(o.sku);
        if (!inventoryId) throw new Error(`${t.name} order for unstocked SKU ${o.sku}`);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO orders (tenant_id, inventory_id, user_id, quantity, status, created_at)
           VALUES ($1, $2, $3, $4, $5, now() - interval '3 days') RETURNING id`,
          [tenantId, inventoryId, userId, o.quantity, o.status],
        );
        const { rowCount } = await client.query(
          `UPDATE inventory_items SET status = 'SOLD', order_id = $1
           WHERE id IN (
             SELECT id FROM inventory_items
             WHERE inventory_id = $2 AND status = 'AVAILABLE'
             ORDER BY id LIMIT $3
           )`,
          [rows[0]!.id, inventoryId, o.quantity],
        );
        if (rowCount !== o.quantity) throw new Error(`${t.name}: could not fill order for ${o.sku}`);
      }

      const { rows: counts } = await client.query<{ sku: string; available: number; sold: number }>(
        `SELECT c.sku,
                count(*) FILTER (WHERE ii.status = 'AVAILABLE')::int AS available,
                count(*) FILTER (WHERE ii.status = 'SOLD')::int AS sold
         FROM inventories inv
         JOIN catalog_items c ON c.id = inv.catalog_item_id
         LEFT JOIN inventory_items ii ON ii.inventory_id = inv.id
         WHERE inv.tenant_id = $1
         GROUP BY c.sku ORDER BY c.sku`,
        [tenantId],
      );
      summary.push({
        tenant: t.name,
        tenantId,
        lines: counts.map(
          (r) => `    ${r.sku.padEnd(16)} ${String(r.available).padStart(3)} available${r.sold ? `  (${r.sold} sold)` : ""}`,
        ),
      });
    }

    await client.query("COMMIT");

    const stocked = new Set(TENANTS.flatMap((t) => Object.keys(t.stock)));
    console.log(`Seeded ${CATALOG.length} catalog items, ${TENANTS.length} tenants.`);
    console.log(`Logins (password: ${PASSWORD}):`);
    for (const t of TENANTS) console.log(`  admin@${t.domain} (admin), user@${t.domain} (user)`);
    for (const s of summary) {
      console.log(`${s.tenant} inventory (tenant ${s.tenantId}):`);
      for (const line of s.lines) console.log(line);
    }
    console.log(`Unstocked everywhere: ${CATALOG.filter((c) => !stocked.has(c.sku)).map((c) => c.sku).join(", ")}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

await seed();
