// Punto de entrada de @joda/domain. packages/domain no puede importar nada
// con I/O — ni Prisma, ni React, ni Fastify, ni fetch, ni fs/path/crypto, ni
// leer Date/Math.random/process.env directamente. Esa regla la impone
// eslint-plugin-boundaries (ver packages/config/eslint/index.js), no la
// convención.
export * from "./shared/index.js";
