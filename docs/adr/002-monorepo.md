# ADR-002 — Monorepo con pnpm y Turborepo

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Repositorio

---

## Contexto

Tres aplicaciones (storefront, admin, api) que comparten tipos, reglas de negocio y componentes. La alternativa era repositorios separados con paquetes publicados.

## Decisión

**Monorepo** con pnpm workspaces y Turborepo.

## Consecuencias

**Positivas.** El activo más valioso del proyecto es el contrato de tipos compartido entre la API y los dos frontends; en monorepo, renombrar un campo rompe la compilación de los tres apps en el CI, en cuarenta segundos. Los cambios que tocan API y cliente son un solo PR atómico. Turborepo cachea tareas y entiende el grafo de dependencias.

**Negativas.** El repositorio crece y el CI corre más cosas. Se mitiga con el filtrado de Turborepo (`--filter`), que solo ejecuta lo afectado.

## Alternativas descartadas

- **Repos separados con paquetes npm privados:** el costo real es la deriva de contratos — se cambia un campo en la API y se descubre en producción.
- **Nx:** más potente (generadores, grafo, boundaries nativos) pero su curva y configuración no se pagan a esta escala. Turborepo hace lo único que hace falta.
