// Lectura y escritura de archivos `.env` (WP-M18). Mismo formato que entienden
// `node --env-file`, `docker compose --env-file` y Vite: una línea por variable,
// `CLAVE=valor`, `#` para comentarios. Un valor con espacios (la ruta de un
// repo clonado en "JODA Parfums ERP Ecomm") va entre comillas dobles; los
// tres lectores las quitan.

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Un valor con comillas, `#`, `$` o saltos de línea se lee distinto según quién
 * abra el archivo; se rechaza acá en vez de escribir un `.env` ambiguo.
 *
 * @param {string} key
 * @param {string} value
 */
export function assertDotenvSafe(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Nombre de variable inválido para un .env: ${key}`);
  }
  if (/["'#$\r\n]/.test(value)) {
    throw new Error(
      `El valor de ${key} tiene comillas, #, $ o un salto de línea: no se puede escribir en un .env que lean node, docker compose y Vite por igual.`,
    );
  }
}

/**
 * @param {ReadonlyArray<{ readonly comment?: string; readonly entries: ReadonlyArray<readonly [string, string]> }>} sections
 * @param {string} header
 */
export function formatDotenv(sections, header) {
  const lines = header.split("\n").map((line) => `# ${line}`.trimEnd());
  for (const section of sections) {
    lines.push("");
    if (section.comment) {
      for (const line of section.comment.split("\n")) lines.push(`# ${line}`.trimEnd());
    }
    for (const [key, value] of section.entries) {
      assertDotenvSafe(key, value);
      lines.push(/\s/.test(value) ? `${key}="${value}"` : `${key}=${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
