import { Router } from "express";
import { requireAuth } from "../auth.js";
import { listCatalogItems } from "./service.js";

export const catalogRouter = Router();

catalogRouter.get("/catalogs", requireAuth, async (_req, res) => {
  res.json(await listCatalogItems());
});
