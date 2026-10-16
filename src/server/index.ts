import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";

export { createApp } from "./app.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`API listening on http://localhost:${port}/api`);
  });
}
