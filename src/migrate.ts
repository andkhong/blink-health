import pg from "pg";
import { readFileSync } from "node:fs";
import { OWNER_DATABASE_URL } from "./db.js";

// Drops and recreates the schema. Local testing only.
export async function migrate(): Promise<void> {
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const client = new pg.Client({ connectionString: OWNER_DATABASE_URL });
  await client.connect();
  try {
    await client.query(schema);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log("schema applied");
}
