#!/usr/bin/env node
import { withClient } from "./lib/client.mjs";
import { applyMigrations, applySeeds, resetSchema } from "./lib/tasks.mjs";

await withClient(async (client) => {
  await resetSchema(client);
  await applyMigrations(client);
  await applySeeds(client);
});
console.log("[db:reset] OK");
