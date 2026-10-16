import express from "express";
import { authRouter } from "./auth.js";
import { catalogRouter } from "./catalog/index.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { inventoryRouter } from "./inventory.js";

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();
  api.use(authRouter);
  api.use(catalogRouter);
  api.use(inventoryRouter);
  api.use(notFoundHandler);

  app.use("/api", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
