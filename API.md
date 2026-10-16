# API contract

Base URL: `http://localhost:3000/api`. The web dev server (Vite, :5173) proxies `/api` to it.
All bodies are JSON. Auth is `Authorization: Bearer <token>` from `/auth/login`.

Errors always look like `{ "error": { "code": string, "message": string } }`.
- 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden` (wrong role),
- 404 `not_found` — also returned for another tenant's inventory (never reveal it exists),
- 409 `insufficient_stock` / `idempotency_conflict`.

## Types

```ts
type Role = "user" | "admin";
type SessionUser = { id: string; email: string; tenantId: string; tenantName: string; role: Role };
type CatalogItem = { id: string; sku: string; name: string; description: string; unitPriceCents: number };
type Inventory = {
  id: string; tenantId: string; catalogItemId: string;
  sku: string; name: string; unitPriceCents: number; // joined from catalog
  count: number;      // number of AVAILABLE units in inventory_items
  updatedBy: string;  // user email
  updatedAt: string;  // ISO timestamp
};
type Order = { id: string; inventoryId: string; quantity: number; status: "PENDING" | "DELIVERED"; createdAt: string };
```

## Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `200 { token, user: SessionUser }`, 401 on bad creds |
| GET | `/auth/me` | – | `200 { user: SessionUser }` |
| POST | `/auth/logout` | – | `204` |

## Catalog (any logged-in role)
| Method | Path | Response |
|---|---|---|
| GET | `/catalogs` | `200 CatalogItem[]` |

## Inventory (always scoped to the caller's tenant)
| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/inventories` | any | – | `200 Inventory[]` |
| GET | `/inventories/:id` | any | – | `200 Inventory` |
| POST | `/inventories` | admin | `{ catalogItemId, quantity }` + header `Idempotency-Key` | `201 Inventory`. Creates the tenant's inventory row for that catalog item if missing, then adds `quantity` AVAILABLE units. |
| PATCH | `/inventories/:id` | user, admin | `{ quantity }` (units to purchase) + header `Idempotency-Key` | `200 { inventory: Inventory, order: Order }`; 409 `insufficient_stock` |
| DELETE | `/inventories/:id?quantity=N` | admin | – | `200 Inventory`. Marks N AVAILABLE units `REMOVED` (all available units if `quantity` omitted); 409 `insufficient_stock` if fewer than N can be claimed. |

`quantity` must be an integer from 1 to 1000. `Idempotency-Key` is required on POST and PATCH.
Replaying the same key with the same body returns the stored status and body without redoing the work;
the same key with a different body returns 409 `idempotency_conflict`.

## Database
Postgres 17 in Docker (`npm run db:up`), at `localhost:5442`. Schema: `src/schema.sql`.
- App connects as `blink_app` (`DATABASE_URL`), which is subject to row-level security.
- Migrations and seeding connect as `blink_owner` (`OWNER_DATABASE_URL`), which bypasses it.
- Use `withTenantTx(tenantId, fn)` from `src/db.ts` for anything touching `inventories`, `inventory_items`,
  `orders` or `idempotency_keys`; without it those tables appear empty. Auth/catalog use `pool` / `withTx`.

## Concurrency (no double checkout): SKIP LOCKED
Each physical unit is a row in `inventory_items`. Checkout, inside `withTenantTx`:
```sql
WITH picked AS (
  SELECT id FROM inventory_items
  WHERE inventory_id = $1 AND status = 'AVAILABLE'
  ORDER BY id LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE inventory_items i SET status = 'SOLD', order_id = $3
FROM picked WHERE i.id = picked.id
RETURNING i.id;
```
Insert the order first (so `order_id` is valid). If fewer than `quantity` rows come back, roll back → 409.
Concurrent buyers claim disjoint units without waiting on each other. Removal uses the same pick with `REMOVED`.

## Seed accounts (password for all: `password123`)
| Email | Tenant | Role |
|---|---|---|
| admin@cvs.test | CVS | admin |
| user@cvs.test | CVS | user |
| admin@walgreens.test | Walgreens | admin |
| user@walgreens.test | Walgreens | user |
