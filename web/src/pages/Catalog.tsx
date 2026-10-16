import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, formatCents, newKey, parseQuantity, ApiError } from "../api";
import type { CatalogItem, Inventory } from "../types";

type RowState = {
  qty: string;
  busy: boolean;
  error?: string;
  success?: string;
  /** Last request that failed retryably (network/5xx): retry reuses its key and body. */
  retry?: { key: string; quantity: number };
};

export function CatalogPage() {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [stock, setStock] = useState<Map<string, Inventory>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cat, inv] = await Promise.all([api.catalogs(), api.inventories()]);
      setItems(cat);
      setStock(new Map(inv.map((i) => [i.catalogItemId, i])));
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const row = (id: string): RowState => rows[id] ?? { qty: "10", busy: false };
  const patchRow = (id: string, p: Partial<RowState>) =>
    setRows((r) => ({ ...r, [id]: { ...(r[id] ?? { qty: "10", busy: false }), ...p } }));

  async function add(item: CatalogItem, reuse?: { key: string; quantity: number }) {
    const quantity = reuse?.quantity ?? parseQuantity(row(item.id).qty);
    if (quantity == null) {
      patchRow(item.id, { error: "Quantity must be an integer from 1 to 1000", success: undefined });
      return;
    }
    const key = reuse?.key ?? newKey();
    patchRow(item.id, { busy: true, error: undefined, success: undefined });
    try {
      const inv = await api.addInventory(item.id, quantity, key);
      setStock((s) => new Map(s).set(item.id, inv));
      patchRow(item.id, {
        busy: false,
        retry: undefined,
        success: `Added ${quantity} → now ${inv.count} available (key ${key.slice(0, 8)}…)`,
      });
    } catch (e) {
      patchRow(item.id, {
        busy: false,
        error: errorMessage(e),
        retry: e instanceof ApiError && e.retryable ? { key, quantity } : undefined,
      });
    }
  }

  return (
    <section>
      <div className="toolbar">
        <h2>Catalog</h2>
        <button className="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="muted small">
        Shared catalog (external source). "Add to inventory" sends <code>POST /api/inventories</code> with a fresh{" "}
        <code>Idempotency-Key</code> per click.
      </p>
      {loadError && <div className="notice error">{loadError}</div>}
      {items && (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Description</th>
              <th className="num">Price</th>
              <th>In our inventory</th>
              <th>Add</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No catalog items.
                </td>
              </tr>
            )}
            {items.map((item) => {
              const r = row(item.id);
              const inv = stock.get(item.id);
              return (
                <tr key={item.id}>
                  <td>
                    <code>{item.sku}</code>
                  </td>
                  <td>{item.name}</td>
                  <td className="desc">{item.description}</td>
                  <td className="num">{formatCents(item.unitPriceCents)}</td>
                  <td>
                    {inv ? (
                      <span className="badge badge-stocked">stocked · {inv.count}</span>
                    ) : (
                      <span className="muted">not stocked</span>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <input
                        className="qty"
                        type="number"
                        min={1}
                        max={1000}
                        value={r.qty}
                        onChange={(e) => patchRow(item.id, { qty: e.target.value })}
                        disabled={r.busy}
                      />
                      <button onClick={() => void add(item)} disabled={r.busy}>
                        {r.busy ? "Adding…" : "Add to inventory"}
                      </button>
                      {r.retry && !r.busy && (
                        <button className="secondary" onClick={() => void add(item, r.retry)}>
                          Retry (same key)
                        </button>
                      )}
                    </div>
                    {r.error && <div className="error-text">{r.error}</div>}
                    {r.success && <div className="ok-text">{r.success}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
