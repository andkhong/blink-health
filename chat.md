# Conversation log

The Claude Code session that set up this project. User messages are verbatim; assistant replies are condensed.

---

## 1. User
> prepare sqlite for local testing in this directory

**Assistant:** The directory was empty. Created `test.db` with the system `sqlite3` (3.51.0), turned on WAL mode, and verified it with a write/read/drop of a test table.

---

## 2. User
> I will use node and typescript

**Assistant:** Ran `npm init` and installed `better-sqlite3`, `typescript`, `tsx`, `@types/node` and `@types/better-sqlite3`. Added `src/db.ts` (`openDb()` with WAL and foreign keys on) and a strict NodeNext `tsconfig.json`. A smoke test ran and the typecheck passed.

---

## 3. User *(message was cut off)*
> ew Design.md, create sub-agents to handle each task. 1 Sub-agent for creating the front-ed portal which includes

**Assistant:** Read `DESIGN.md` and asked for the rest of the task list. *(Interrupted by the user.)*

---

## 4. User
```
Review Design.md
    Create sub agents for the following tasks
        Opus 5.5 for front-end (user login portal).
            2 pages.
                1 Catalog Page (for admins)
                1 Inventory Page (for users)
                    user can view inventory and modify inventory quanity
        Opus 5.5 for seeding database entries of Catalog and inventory
        Opus 5.5 for back-end development
            create catalog route to get catalog details
            create inventory routes
                - admins can add new inventories from catalog ids
                - users can modify inventory count

    Constraints
        2 customers can interact with an inventory; we can avoid this by utilize SKIP-LOCKED pattern for inventory.
```

**Assistant:** Pointed out that SQLite has no `SKIP LOCKED` and proposed an equivalent: an immediate write transaction with a conditional decrement. Started writing the shared schema and the API contract (`API.md`) for the agents. *(Interrupted by the user.)*

---

## 5. User
> Switch to postgres to allow for skip-locked pattern. Tell me how you will approach this with inventory quanity and new tables to correspond with specific inventories

**Assistant:** Proposed the design:
- **One row per physical unit** (`inventory_items`, status `AVAILABLE` / `SOLD` / `REMOVED`) instead of a `count` column. `SKIP LOCKED` needs many rows to skip between; with a single count row it can't help.
- **Count** is the number of `AVAILABLE` units. Admins add stock by inserting N rows with `generate_series`.
- **Checkout** claims N units with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N`, marks them `SOLD` and links them to the order. Fewer than N claimed → roll back and return 409.
- **Admin removal** uses the same pick, marking units `REMOVED`.
- **Tenant isolation:** `tenant_id` on every row, composite foreign keys, and optionally Postgres row-level security.
- **Infrastructure:** Postgres in Docker and the `pg` driver.
- **Then** three sub-agents (frontend, seed, backend).

---

## 6. User
> Go ahead, elaborate row-level security, i am not too familiar with this

**Assistant:** Explained row-level security:
- **Policies:** `USING` filters which rows reads, updates and deletes can see; `WITH CHECK` blocks writing rows for another tenant.
- **Tenant setting:** a transaction-local `app.tenant_id` that the backend sets from the session.
- **Fails closed:** if the tenant isn't set, queries return nothing.
- **Pitfalls handled:** superusers and table owners bypass it, so the app connects as a limited `blink_app` role.

Then set up the database:
- **Postgres 17 in Docker** on port 5442, because 5432 and 5433 were taken by other projects.
- **Wrote** `src/schema.sql` (with RLS), `src/db.ts` (`withTx` / `withTenantTx`), `src/migrate.ts` and `src/password.ts`.
- **Verified RLS** as `blink_app`: no tenant set → 0 rows, tenant A → its own rows, tenant B → 0.
- **Rewrote `API.md`** for Postgres and `SKIP LOCKED`.

---

## 7. User *(sent while the assistant was working)*
> Proceed with implementations with sub-agents

**Assistant:** Launched three Opus 5.5 sub-agents in parallel, each owning separate files:
- **Backend** (`src/server/`): Express 5 with auth, catalog and inventory routes, `SKIP LOCKED` checkout and removal, and idempotency keys. 17 tests run against a separate `blink_test` database.
- **Seed** (`src/seed.ts`): CVS and Walgreens, an admin and a user for each (`password123`), 12 catalog items, varied stock including low-stock items, and a few historical orders.
- **Frontend** (`web/`): Vite and React with login quick-fill, a Catalog page (admins), an Inventory page (purchase, plus remove for admins), a concurrent-purchase simulator and an isolation probe.

Checked the result independently:
- **Checks:** typecheck clean, 17/17 tests pass, web build succeeds.
- **Isolation:** through the web dev server proxy, a Walgreens user gets 404 on a CVS item.
- **Roles:** a CVS user gets 403 on an admin-only action.
- **Concurrency:** 5 simultaneous purchases with 2 in stock gave 2 successes, 3 rejections (409) and a final count of 0.

---

## 8. User
> export the user messages/conversation into a seeparate chat.md in this repo

**Assistant:** Wrote this file.
