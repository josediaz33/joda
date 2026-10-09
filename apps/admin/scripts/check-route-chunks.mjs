import { readFileSync } from "node:fs";
import { stdout } from "node:process";
import { URL } from "node:url";

const manifest = JSON.parse(
  readFileSync(new URL("../dist/.vite/manifest.json", import.meta.url), "utf8"),
);
const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entry) throw new Error("El build no generó un chunk de entrada.");

const staticImports = new Set();
function walk(key) {
  if (staticImports.has(key)) return;
  staticImports.add(key);
  for (const imported of manifest[key]?.imports ?? []) walk(imported);
}
walk(entry);

for (const route of [
  "Login",
  "Enroll",
  "Verify",
  "Home",
  "CatalogPreview",
  "Accounting",
  "Sourcing",
]) {
  const key = `src/routes/${route}.tsx`;
  if (
    !manifest[key]?.file ||
    staticImports.has(key) ||
    !manifest[entry].dynamicImports?.includes(key)
  ) {
    throw new Error(`La ruta ${route} no tiene un chunk diferido independiente.`);
  }
  stdout.write(`${route}: ${manifest[key].file} (carga diferida)\n`);
}

stdout.write("Contabilidad no forma parte del grafo estático del vendedor.\n");
