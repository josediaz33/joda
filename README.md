# JODA Parfums — ERP & E-commerce

Ecosistema ERP + e-commerce para una perfumería y relojería de nicho en
Encarnación, Paraguay. Migra desde una PWA offline-first (React + Dexie/IndexedDB)
a una plataforma cloud desacoplada: storefront público (Next.js), backoffice/ERP
(React + Vite) y una API central (Fastify + tRPC) como único punto de escritura
sobre PostgreSQL.

El dominio vende fracciones de perfume ("decants"): un frasco se abre y se
vende de a 5, 10 o 30 ml, descontando mililitros y merma de un lote con costo
real de importación. Ver [`GLOSARIO.md`](./GLOSARIO.md) para el lenguaje del
dominio y [`docs/domain-rules.md`](./docs/domain-rules.md) para las reglas.

## Cómo arrancar

```bash
pnpm install
pnpm typecheck
pnpm lint
```

El monorepo (pnpm workspaces, Turborepo, tsconfig compartido, ESLint con
`eslint-plugin-boundaries`, Prettier) está inicializado desde WP-A01. Todavía
no hay apps ni dominio funcionando más allá del esqueleto — eso llega en los
paquetes de trabajo siguientes, ver [`docs/backlog.md`](./docs/backlog.md).

## Índice

- [`CLAUDE.md`](./CLAUDE.md) — contexto del proyecto y reglas no negociables.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — cómo contribuir.
- [`docs/architecture/`](./docs/architecture/) — arquitectura de referencia.
- [`docs/adr/`](./docs/adr/) — decisiones arquitectónicas.
- [`docs/backlog.md`](./docs/backlog.md) — plan de trabajo y paquetes.
