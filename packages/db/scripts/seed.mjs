#!/usr/bin/env node
import { withClient } from "./lib/client.mjs";
import { applySeeds } from "./lib/tasks.mjs";

await withClient(applySeeds);
console.log("[db:seed] OK");
