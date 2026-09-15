// Lógica pura del guarda de ADR-018 (scripts/hooks/block-prisma-migrate.mjs).
// Separada en un módulo importable para poder testearla sin invocar el hook
// completo (que lee stdin y hace process.exit) — ver prisma-guard.test.mjs.
//
// No basta con buscar "prisma migrate" en el string entero: un comando
// compuesto (`echo ok && npx prisma migrate dev`), una continuación de línea
// de Bash (`prisma \` + salto de línea + `migrate`), o una invocación con
// versión fijada (`prisma@5.9.1 migrate`) tienen que bloquearse igual. Y
// `prisma db push` escribe el esquema por fuera de las migraciones — viola
// ADR-018 tanto como `migrate`, aunque no comparta la palabra.

// Una continuación de línea de Bash ("\" + salto) es whitespace a efectos de
// lectura humana del comando, pero \s no la reconoce como tal porque el "\"
// no es un espacio. Normalizarla ANTES de partir en segmentos evita que
// alguien separe "prisma" de "migrate" con una barra + salto de línea para
// esquivar el patrón.
const LINE_CONTINUATION = /\\\r?\n/g;

// Separadores reales de sentencias en Bash: encadenamiento (&&, ||, ;, |) y
// saltos de línea sueltos (sentencias una debajo de la otra). Partir por acá
// dice qué sub-comando disparó el bloqueo, y evita que un match dependa de
// que dos sentencias no relacionadas queden pegadas por casualidad.
const SEGMENT_SPLIT = /&&|\|\||;|\||\r?\n/;

// prisma(@version opcional) + espacio(s) + migrate | db push
const DANGEROUS_PATTERN = /prisma(?:@\S+)?\s+(migrate|db\s+push)/i;

/**
 * Devuelve el primer segmento del comando que viola ADR-018, o null si
 * ninguno lo hace. Un "segmento" es cada sub-comando entre separadores de
 * Bash — no el comando completo — para que un `&&`/`;`/salto de línea no
 * esconda la invocación real en medio de otras.
 */
export function findBlockedPrismaSegment(command) {
  const normalized = String(command ?? "").replace(LINE_CONTINUATION, " ");
  const segments = normalized.split(SEGMENT_SPLIT);
  return segments.find((segment) => DANGEROUS_PATTERN.test(segment)) ?? null;
}
