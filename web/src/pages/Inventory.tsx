import { useCallback, useEffect, useState } from "react";
import { api, ApiError, errorMessage, newKey, parseQuantity } from "../api";
import { useUser } from "../auth";
import type { Inventory } from "../types";

type RowState = {
  buyQty: string;
  removeQty: string;
  busy: boolean;
  error?: string;
  success?: string;
  /** Last purchase that failed retryably (network/5xx): retry reuses its key and body. */
  retry?: { key: string; quantity: number };
};
const emptyRow: RowState = { buyQty: "1", removeQty: "1", busy: false };

type SimResult = {
  inventoryLabel: string;
  n: number;
  succeeded: number;
  insufficient: number;
  other: string[];
  countBefore: number;
  countAfter: number | null;
  ms: number;
};

export function InventoryPage() {
  const user = useUser();
  const isAdmin = user.role === "admin";
  const [items, setItems] = useState<Inventory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setItems(await api.inventories());
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const row = (id: string) => rows[id] ?? emptyRow;
  const patchRow = (id: string, p: Partial<RowState>) =>
    setRows((r) => ({ ...r, [id]: { ...(r[id] ?? emptyRow), ...p } }));
  const replaceItem = (inv: Inventory) =>
    setItems((list) => (list ? list.map((i) => (i.id === inv.id ? inv : i)) : list));

  async function refreshOne(id: string) {
    try {
      replaceItem(await api.inventory(id));
    } catch {
      /* the row-level error is already shown */
    }
  }

  async function purchase(inv: Inventory, reuse?: { key: string; quantity: number }) {
    const quantity = reuse?.quantity ?? parseQuantity(row(inv.id).buyQty);
    if (quantity == null) {
      patchRow(inv.id, { error: "Quantity must be an integer from 1 to 1000", success: undefined });
      return;
    }
    const key = reuse?.key ?? newKey();
    patchRow(inv.id, { busy: true, error: undefined, success: undefined });
    try {
      const { inventory, order } = await api.purchase(inv.id, quantity, key);
      replaceItem(inventory);
      patchRow(inv.id, {
        busy: false,
        retry: undefined,
        success: `Order ${order.id} · ${order.status} · qty ${order.quantity} → ${inventory.count} left`,
      });
    } catch (e) {
      let msg = errorMessage(e);
      if (e instanceof ApiError && e.code === "insufficient_stock") {
        msg += " — someone else may have bought it; count refreshed.";
        void refreshOne(inv.id);
      }
      patchRow(inv.id, {
        busy: false,
        error: msg,
        retry: e instanceof ApiError && e.retryable ? { key, quantity } : undefined,
      });
    }
  }

  async function remove(inv: Inventory) {
    const raw = row(inv.id).removeQty.trim();
    let quantity: number | null = null;
    if (raw !== "") {
      quantity = parseQuantity(raw);
      if (quantity == null) {
        patchRow(inv.id, { error: "Remove quantity must be an integer from 1 to 1000 (or blank = all)", success: undefined });
        return;
      }
    } else if (!confirm(`Remove ALL available units of ${inv.sku}?`)) {
      return;
    }
    patchRow(inv.id, { busy: true, error: undefined, success: undefined });
    try {
      const updated = await api.remove(inv.id, quantity);
      replaceItem(updated);
      patchRow(inv.id, {
        busy: false,
        success: `Removed ${quantity ?? "all"} → ${updated.count} left`,
      });
    } catch (e) {
      let msg = errorMessage(e);
      if (e instanceof ApiError && e.code === "insufficient_stock") {
        msg += " — count refreshed.";
        void refreshOne(inv.id);
      }
      patchRow(inv.id, { busy: false, error: msg });
    }
  }

  return (
    <section>
      <div className="toolbar">
        <h2>Inventory · {user.tenantName}</h2>
        <button className="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {loadError && <div className="notice error">{loadError}</div>}
      {items && (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th className="num">Count</th>
              <th>Updated by</th>
              <th>Updated at</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No inventory for this tenant yet{isAdmin ? " — add some from the Catalog tab." : "."}
                </td>
              </tr>
            )}
            {items.map((inv) => {
              const r = row(inv.id);
              return (
                <tr key={inv.id}>
                  <td>
                    <code>{inv.sku}</code>
                    <div className="muted tiny" title="Inventory id (use for isolation lookups)">
                      {inv.id}
                    </div>
                  </td>
                  <td>{inv.name}</td>
                  <td className="num">
                    <strong>{inv.count}</strong>
                  </td>
                  <td>{inv.updatedBy}</td>
                  <td className="small">{new Date(inv.updatedAt).toLocaleString()}</td>
                  <td>
                    <div className="actions">
                      <input
                        className="qty"
                        type="number"
                        min={1}
                        max={1000}
                        value={r.buyQty}
                        onChange={(e) => patchRow(inv.id, { buyQty: e.target.value })}
                        disabled={r.busy}
                        aria-label="Purchase quantity"
                      />
                      <button onClick={() => void purchase(inv)} disabled={r.busy}>
                        {r.busy ? "Working…" : "Purchase"}
                      </button>
                      {r.retry && !r.busy && (
                        <button className="secondary" onClick={() => void purchase(inv, r.retry)}>
                          Retry (same key)
                        </button>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="actions">
                        <input
                          className="qty"
                          type="number"
                          min={1}
                          max={1000}
                          placeholder="all"
                          value={r.removeQty}
                          onChange={(e) => patchRow(inv.id, { removeQty: e.target.value })}
                          disabled={r.busy}
                          aria-label="Remove quantity"
                        />
                        <button className="danger" onClick={() => void remove(inv)} disabled={r.busy}>
                          Remove
                        </button>
                      </div>
                    )}
                    {r.error && <div className="error-text">{r.error}</div>}
                    {r.success && <div className="ok-text">{r.success}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {items && items.length > 0 && <ConcurrencySimulator items={items} onDone={load} />}
      <IsolationProbe />
    </section>
  );
}

function ConcurrencySimulator({ items, onDone }: { items: Inventory[]; onDone: () => Promise<void> }) {
  const [targetId, setTargetId] = useState(items[0]?.id ?? "");
  const [nRaw, setNRaw] = useState("10");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = items.find((i) => i.id === targetId) ?? items[0];

  async function run() {
    const n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      setError("N must be an integer from 1 to 200");
      return;
    }
    if (!target) return;
    setError(null);
    setRunning(true);
    setResult(null);
    const countBefore = target.count;
    const started = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () => api.purchase(target.id, 1, newKey())),
    );
    const ms = Math.round(performance.now() - started);
    let succeeded = 0;
    let insufficient = 0;
    const other: string[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") succeeded++;
      else if (s.reason instanceof ApiError && s.reason.code === "insufficient_stock") insufficient++;
      else other.push(errorMessage(s.reason));
    }
    let countAfter: number | null = null;
    try {
      countAfter = (await api.inventory(target.id)).count;
    } catch {
      /* ignore */
    }
    setResult({ inventoryLabel: `${target.sku} (${target.name})`, n, succeeded, insufficient, other, countBefore, countAfter, ms });
    setRunning(false);
    await onDone();
  }

  return (
    <div className="card sim">
      <h3>Simulate concurrent purchases</h3>
      <p className="muted small">
        Fires N parallel <code>PATCH /api/inventories/:id {"{ quantity: 1 }"}</code> requests, each with a distinct{" "}
        <code>Idempotency-Key</code>. With SKIP LOCKED, successes should equal min(N, count) and no unit is sold twice.
        Note: browsers cap ~6 concurrent HTTP/1.1 connections per origin, so requests overlap in waves.
      </p>
      <div className="actions">
        <select value={target?.id} onChange={(e) => setTargetId(e.target.value)} disabled={running}>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.sku} — {i.name} (count {i.count})
            </option>
          ))}
        </select>
        <label className="inline">
          N
          <input className="qty" type="number" min={1} max={200} value={nRaw} onChange={(e) => setNRaw(e.target.value)} disabled={running} />
        </label>
        <button onClick={() => void run()} disabled={running || !target}>
          {running ? "Running…" : `Fire ${nRaw} purchases`}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <div className={`notice ${result.other.length ? "warn" : "info"}`}>
          <div>
            <strong>{result.inventoryLabel}</strong>: {result.n} requests in {result.ms} ms
          </div>
          <div>
            <strong className="ok-text">{result.succeeded} succeeded</strong>,{" "}
            <strong className="error-text">{result.insufficient} rejected (insufficient stock)</strong>
            {result.other.length > 0 && <>, {result.other.length} other errors</>}
          </div>
          <div className="small">
            Count before: {result.countBefore} → after: {result.countAfter ?? "?"}{" "}
            {result.countAfter != null &&
              (result.countBefore - result.countAfter === result.succeeded ? (
                <span className="ok-text">(consistent: decreased by exactly the successes)</span>
              ) : (
                <span className="error-text">
                  (decrease {result.countBefore - result.countAfter} ≠ successes {result.succeeded}; other writers may have
                  run concurrently)
                </span>
              ))}
          </div>
          {result.other.length > 0 && (
            <ul className="small">
              {[...new Set(result.other)].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** GET /api/inventories/:id — paste another tenant's inventory id; isolation means it must 404. */
function IsolationProbe() {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);

  async function probe() {
    if (!id.trim()) return;
    setBusy(true);
    setOut(null);
    try {
      const inv = await api.inventory(id.trim());
      setOut({ ok: true, text: `200 → ${inv.sku} ${inv.name}, count ${inv.count}, tenant ${inv.tenantId}` });
    } catch (e) {
      setOut({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Isolation probe</h3>
      <p className="muted small">
        Look up an inventory by id (<code>GET /api/inventories/:id</code>). Copy an id while logged in as another tenant;
        it should return <code>404 not_found</code> here.
      </p>
      <div className="actions">
        <input className="wide" placeholder="inventory id" value={id} onChange={(e) => setId(e.target.value)} />
        <button className="secondary" onClick={() => void probe()} disabled={busy || !id.trim()}>
          {busy ? "Looking up…" : "Look up"}
        </button>
      </div>
      {out && <div className={out.ok ? "ok-text" : "error-text"}>{out.text}</div>}
    </div>
  );
}
