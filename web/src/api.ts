import type { CatalogItem, Inventory, LoginResponse, PurchaseResponse, SessionUser } from "./types";

const TOKEN_KEY = "blink.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** status 0 = network failure (no response) — safe to retry with the same Idempotency-Key. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type RequestOpts = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Don't trigger global logout on 401 (used by login itself). */
  skipAuthRedirect?: boolean;
};

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "network_error", `Network error: ${(e as Error).message}`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    const apiErr = new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `HTTP ${res.status} ${res.statusText}`,
    );
    if (res.status === 401 && !opts.skipAuthRedirect) onUnauthorized();
    throw apiErr;
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: { email, password }, skipAuthRedirect: true }),
  me: () => request<{ user: SessionUser }>("/auth/me", { skipAuthRedirect: true }),
  logout: () => request<void>("/auth/logout", { method: "POST", skipAuthRedirect: true }),

  catalogs: () => request<CatalogItem[]>("/catalogs"),

  inventories: () => request<Inventory[]>("/inventories"),
  inventory: (id: string) => request<Inventory>(`/inventories/${encodeURIComponent(id)}`),
  addInventory: (catalogItemId: string, quantity: number, idempotencyKey: string) =>
    request<Inventory>("/inventories", { method: "POST", body: { catalogItemId, quantity }, idempotencyKey }),
  purchase: (id: string, quantity: number, idempotencyKey: string) =>
    request<PurchaseResponse>(`/inventories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { quantity },
      idempotencyKey,
    }),
  remove: (id: string, quantity: number | null) =>
    request<Inventory>(
      `/inventories/${encodeURIComponent(id)}${quantity == null ? "" : `?quantity=${quantity}`}`,
      { method: "DELETE" },
    ),
};

export function newKey(): string {
  return crypto.randomUUID();
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return `${e.status ? e.status + " " : ""}${e.code}: ${e.message}`;
  return String(e);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Client-side check matching API.md: integer 1..1000. Returns null if invalid. */
export function parseQuantity(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 1 && n <= 1000 ? n : null;
}
