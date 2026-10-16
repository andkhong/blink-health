// Mirrors the types in /API.md exactly.
export type Role = "user" | "admin";
export type SessionUser = { id: string; email: string; tenantId: string; tenantName: string; role: Role };
export type CatalogItem = { id: string; sku: string; name: string; description: string; unitPriceCents: number };
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
export type LoginResponse = { token: string; user: SessionUser };
export type PurchaseResponse = { inventory: Inventory; order: Order };
