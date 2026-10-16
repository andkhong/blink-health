# Blink Health — multi-tenant pharmacy inventory

A small inventory system where several pharmacies (tenants) each manage their own isolated stock.
Admins add stock from a shared catalog; pharmacists purchase from their tenant's inventory.
Concurrent purchases of the same item can never sell the same unit twice.

- **Backend:** Node 24, TypeScript, Express 5, Postgres 17 (`pg`)
- **Frontend:** Vite + React portal in `web/`, for manual testing
- **Contract:** [`API.md`](API.md) · original notes: [`DESIGN.md`](DESIGN.md) · build log: [`chat.md`](chat.md)

## Running locally

Prerequisites: Node 24+ and Docker.

```sh
npm install
npm --prefix web install

npm run db:up       # start Postgres 17 in Docker on localhost:5442
npm run db:reset    # create the schema and load seed data

npm run dev:api     # API on http://localhost:3000
npm run dev:web     # portal on http://localhost:5173 (in a second terminal)
```

Open http://localhost:5173 and log in with one of the seed accounts (the login page has quick-fill buttons):

| Email | Tenant | Role |
|---|---|---|
| admin@cvs.test | CVS | admin |
| user@cvs.test | CVS | user |
| admin@walgreens.test | Walgreens | admin |
| user@walgreens.test | Walgreens | user |

Password for all: `password123`. Run `npm run db:reset` any time to restore the starting data.

## Tests

```sh
npm test            # backend tests, against a separate blink_test database
npm run typecheck
```

Tests cover login, role checks, tenant isolation, the row-level security backstop,
20 concurrent purchases against 10 units (exactly 10 succeed), and idempotent retries.

## What the app does

| Role | Can |
|---|---|
| **admin** | Browse the catalog, add stock for an item, remove stock, purchase |
| **user** | View their tenant's inventory and purchase |

- **Catalog page** (admins): every catalog item, with "Add to inventory".
- **Inventory page** (everyone): stock levels and Purchase; admins also get Remove.
  It includes a "Simulate N concurrent purchases" control to watch double-checkout protection,
  and an isolation probe that should return 404 for another tenant's inventory id.

## How it works

**One row per unit.** `inventories` holds one row per (tenant, catalog item); each physical unit is a row
in `inventory_items` with status `AVAILABLE`, `SOLD` or `REMOVED`. The count shown is the number of
`AVAILABLE` units.

**No double checkout (`SKIP LOCKED`).** A purchase claims N units with
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT N`, marks them `SOLD` and links them to the order.
Concurrent buyers lock different units instead of waiting on each other. If fewer than N units can be
claimed, the transaction rolls back and the API returns `409 insufficient_stock`.

**Idempotency.** `POST` and `PATCH` require an `Idempotency-Key` header. Retrying with the same key
returns the original response without buying or adding stock again; failed requests aren't stored, so
they can be retried.

**Tenant isolation, two layers.**
1. Every query filters on the logged-in user's `tenant_id`; another tenant's ids return 404.
2. Postgres row-level security on `inventories`, `inventory_items`, `orders` and `idempotency_keys`.
   The app connects as the limited `blink_app` role, and `withTenantTx()` sets `app.tenant_id` per
   transaction. If it's ever not set, those tables return no rows.

## Project layout

```
src/
  schema.sql        tables, row-level security policies, app role
  db.ts             connection pool, withTx / withTenantTx
  migrate.ts        drops and recreates the schema (local only)
  seed.ts           seed tenants, users, catalog, stock, orders
  password.ts       scrypt password hashing
  server/           Express API: auth, catalog/, inventory, idempotency, tests
web/                Vite + React portal
docker-compose.yml  Postgres 17 on localhost:5442
```

## Notes

- Credentials in this repo (`blink_owner`, `blink_app`, `password123`) are for the local Docker database only.
- Postgres uses port 5442 to avoid clashing with other local Postgres instances on 5432.
