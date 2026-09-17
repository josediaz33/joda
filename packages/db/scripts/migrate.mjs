#!/usr/bin/env node
import { withClient } from "./lib/client.mjs";
import { applyMigrations } from "./lib/tasks.mjs";

await withClient(applyMigrations);
console.log("[db:migrate] OK");
