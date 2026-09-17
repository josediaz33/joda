#!/usr/bin/env node
import { withClient } from "./lib/client.mjs";
import { runSmokeBusinessFlow } from "./lib/smoke.mjs";
import { runInvariants } from "./lib/invariants.mjs";

// Orden fijo: invariants.sql referencia filas que solo existen después de
// correr smoke_business_flow.sql (ver el encabezado de invariants.sql).
await withClient(async (client) => {
  await runSmokeBusinessFlow(client);
  await runInvariants(client);
});
console.log("[db:test] OK");
