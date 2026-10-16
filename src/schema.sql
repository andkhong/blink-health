-- Shared schema. Applied by src/migrate.ts as the owner role; wipes and recreates `public`.
-- The app connects as blink_app, which is NOT the owner, so row-level security applies to it.

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blink_app') THEN
    CREATE ROLE blink_app LOGIN PASSWORD 'blink_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO blink_app;

CREATE TYPE role_type AS ENUM ('user', 'admin');
CREATE TYPE unit_status AS ENUM ('AVAILABLE', 'SOLD', 'REMOVED');
CREATE TYPE order_status AS ENUM ('PENDING', 'DELIVERED');

-- Catalog: stands in for the external catalog system. Only src/server/catalog/* reads it.
CREATE TABLE catalog_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE tenants (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE roles (
  id   integer PRIMARY KEY,
  type role_type NOT NULL UNIQUE
);
INSERT INTO roles (id, type) VALUES (1, 'user'), (2, 'admin');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  role_id       integer NOT NULL REFERENCES roles(id)
);

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- One row per (tenant, catalog item). Quantity lives in inventory_items, not here.
CREATE TABLE inventories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  catalog_item_id uuid NOT NULL, -- external catalog id, no FK by design
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, catalog_item_id),
  UNIQUE (id, tenant_id) -- target for composite FKs below
);

CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  inventory_id uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id),
  quantity     integer NOT NULL CHECK (quantity > 0),
  status       order_status NOT NULL DEFAULT 'PENDING',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (inventory_id, tenant_id) REFERENCES inventories (id, tenant_id)
);

-- One row per physical unit. Checkout claims units with FOR UPDATE SKIP LOCKED.
CREATE TABLE inventory_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_id uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  status       unit_status NOT NULL DEFAULT 'AVAILABLE',
  order_id     uuid,
  added_by     uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inventory_id, tenant_id) REFERENCES inventories (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id),
  CHECK ((status = 'SOLD') = (order_id IS NOT NULL))
);
CREATE INDEX inventory_items_available ON inventory_items (inventory_id) WHERE status = 'AVAILABLE';

-- Stored responses for Idempotency-Key replays, scoped per tenant.
CREATE TABLE idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response_json jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Row-level security: every tenant-owned table only shows rows matching app.tenant_id.
-- Unset/empty app.tenant_id compares as NULL, so a forgotten tenant context sees nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventories', 'orders', 'inventory_items', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;

GRANT SELECT ON catalog_items, tenants, roles, users TO blink_app;
GRANT SELECT, INSERT, DELETE ON sessions TO blink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventories, orders, inventory_items, idempotency_keys TO blink_app;
