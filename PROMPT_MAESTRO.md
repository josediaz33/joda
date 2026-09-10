# PROMPT MAESTRO — Inicialización del repositorio JODA Parfums

Copiá el bloque de abajo y pegalo en Claude Code, en la carpeta vacía donde va a vivir el repositorio. Adjuntá los archivos de documentación en la misma sesión.

---

```
Vas a inicializar el repositorio del proyecto "JODA Parfums — ERP & E-commerce".

Este es un trabajo de andamiaje y colocación de documentación. NO escribas
código de aplicación todavía: la primera tarea de desarrollo es WP-A01 del
backlog, y la vas a tomar en una sesión aparte.

═══════════════════════════════════════════════════════════════════
PASO 1 · Estructura de carpetas
═══════════════════════════════════════════════════════════════════

Creá exactamente este árbol:

joda/
├── apps/
│   ├── storefront/
│   ├── admin/
│   └── api/
├── packages/
│   ├── contracts/
│   ├── domain/
│   ├── db/
│   │   ├── migrations/
│   │   ├── seed/
│   │   ├── tests/
│   │   └── prisma/
│   ├── ui/
│   ├── sdk/
│   └── config/
├── infra/
│   ├── supabase/
│   ├── docker/
│   └── deployment/
├── docs/
│   ├── adr/
│   ├── architecture/
│   └── runbooks/
└── .claude/
    └── rules/

Poné un .gitkeep en cada carpeta que quede vacía.

═══════════════════════════════════════════════════════════════════
PASO 2 · Colocación de los documentos adjuntos
═══════════════════════════════════════════════════════════════════

Copiá cada archivo adjunto EXACTAMENTE en esta ruta. No los renombres,
no los edites, no los resumas.

RAÍZ DEL REPOSITORIO
  CLAUDE.md                            → ./CLAUDE.md
  GLOSARIO.md                          → ./GLOSARIO.md
  CONTRIBUTING.md                      → ./CONTRIBUTING.md

ARQUITECTURA
  JODA_Arquitectura_v5_Final.md        → ./docs/architecture/JODA_Arquitectura_v5_Final.md

ESPECIFICACIONES
  especificacion-software.md           → ./docs/especificacion-software.md
  domain-rules.md                      → ./docs/domain-rules.md
  domain-contracts.md                  → ./docs/domain-contracts.md
  data-model.md                        → ./docs/data-model.md
  api-conventions.md                   → ./docs/api-conventions.md
  frontend-spec.md                     → ./docs/frontend-spec.md
  security-spec.md                     → ./docs/security-spec.md
  engineering-principles.md            → ./docs/engineering-principles.md
  testing-strategy.md                  → ./docs/testing-strategy.md
  backlog.md                           → ./docs/backlog.md

RUNBOOKS
  prompts-playbook.md                  → ./docs/runbooks/prompts-playbook.md

REGLAS CON ALCANCE POR RUTA (6 archivos)
  domain.md · database.md · api.md · frontend.md · contracts.md · testing.md
                                       → ./.claude/rules/<mismo nombre>
  Estas se cargan solas cuando trabajes con archivos que coincidan con su
  frontmatter `paths`. No las muevas ni les cambies el frontmatter.

DECISIONES ARQUITECTÓNICAS (24 archivos)
  Todos los que empiezan con un número de tres dígitos, más su README:
  001-monolito-modular.md   … 023-stack-frontend.md   y   README.md
                                       → ./docs/adr/<mismo nombre>

BASE DE DATOS
  Los 10 archivos de migración         → ./packages/db/migrations/<mismo nombre>
    0001_foundation.sql
    0002_identity_rbac.sql
    0003_catalog.sql
    0004_inventory.sql
    0005_procurement.sql
    0006_sales.sql
    0007_accounting.sql
    0008_fiscal.sql
    0009_invariants.sql
    0010_security_rls.sql
  0001_seed_base.sql                   → ./packages/db/seed/0001_seed_base.sql
  smoke_business_flow.sql              → ./packages/db/tests/smoke_business_flow.sql
  invariants.sql                       → ./packages/db/tests/invariants.sql
  schema.prisma                        → ./packages/db/prisma/schema.prisma
  README.md (el de packages/db)        → ./packages/db/README.md

  schema_dump_verificado.sql           → ./packages/db/prisma/.reference-dump.sql
    (referencia únicamente; agregalo a .gitignore, no se versiona)

Cuando termines este paso, listá el árbol completo con `find . -type f | sort`
para que yo pueda verificar la colocación.

═══════════════════════════════════════════════════════════════════
PASO 3 · Archivos de configuración base
═══════════════════════════════════════════════════════════════════

Creá, sin instalar dependencias todavía:

  .gitignore          node_modules, dist, .env, .turbo, coverage, *.log,
                      packages/db/prisma/.reference-dump.sql
  .env.example        documentá las variables SIN valores:
                      DATABASE_URL, DATABASE_URL_READONLY, REDIS_URL,
                      SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
                      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
                      R2_BUCKET_PUBLIC, SESSION_SECRET, APP_URL, ADMIN_URL
  README.md           breve: qué es el proyecto, cómo arrancar, y un índice
                      que enlace CLAUDE.md, CONTRIBUTING.md, docs/architecture,
                      docs/adr y docs/backlog.md
  LICENSE             UNLICENSED / propietario

═══════════════════════════════════════════════════════════════════
PASO 4 · Verificación de coherencia
═══════════════════════════════════════════════════════════════════

Leé CLAUDE.md, GLOSARIO.md, docs/adr/README.md y docs/backlog.md, y
reportame:

  a) Cualquier ruta mencionada en la documentación que no exista en el
     árbol que acabás de crear.
  b) Cualquier comando de CLAUDE.md que todavía no tenga implementación
     (es esperable: los scripts se crean en WP-A01, solo listalos).
  c) Cualquier contradicción que encuentres ENTRE documentos.
  d) Cualquier término usado en las especificaciones que no esté en
     GLOSARIO.md.

No corrijas nada por tu cuenta: reportá y esperá indicación.

═══════════════════════════════════════════════════════════════════
PASO 5 · Commit inicial
═══════════════════════════════════════════════════════════════════

  git init
  git add .
  git commit -m "chore: estructura del repositorio y documentación base

  Documentación de arquitectura v5, 23 ADRs, especificación de software,
  reglas de negocio, contratos de dominio, modelo de datos, convenciones
  de API, especificación de frontend, especificación de seguridad,
  principios de ingeniería, estrategia de pruebas, backlog y playbook
  de prompts.

  Esquema de base de datos validado contra PostgreSQL 16: 61 tablas,
  104 CHECK, 138 claves foráneas, 18/18 invariantes verificados."

═══════════════════════════════════════════════════════════════════
PASO 6 · Repositorio remoto
═══════════════════════════════════════════════════════════════════

Creá el repositorio en GitHub y subí la base. **PRIVADO**: el ERP es un
activo competitivo y un posible producto.

  gh repo create joda --private --source=. --remote=origin
  git push -u origin main
  git push origin v0.0.1-docs

Si no tenés gh instalado, decímelo y lo creo yo desde la web; vos hacés
solo el `git remote add origin <url>` y el push.

Verificá antes de empujar que .gitignore excluye:
  .env · node_modules · .turbo · coverage
  packages/db/prisma/.reference-dump.sql

Después del push, configurá la protección de main:

  gh api repos/:owner/joda/branches/main/protection -X PUT --input - <<'JSON'
  {
    "required_status_checks": null,
    "enforce_admins": false,
    "required_pull_request_reviews": { "required_approving_review_count": 1 },
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  JSON

Reportame si la protección quedó activa. A partir de acá, TODO cambio va
por rama y pull request, incluido el tuyo.

═══════════════════════════════════════════════════════════════════
REGLAS PARA ESTA SESIÓN
═══════════════════════════════════════════════════════════════════

· NO instales dependencias. NO corras pnpm install.
· NO escribas código de aplicación, ni siquiera de ejemplo.
· NO edites, resumas ni "mejores" ningún documento adjunto.
· NO tomes decisiones que ya estén en un ADR.
· Si algo de estas instrucciones no coincide con lo que ves en los
  archivos adjuntos, PARÁ Y PREGUNTÁ. No adivines.

· NO empujes a main después del Paso 6. A partir de ahí, ramas y PR.

Empezá por el Paso 1 y avanzá en orden, confirmando cada paso.
```

---

## Después de esta sesión

**Segunda sesión — WP-A01** (monorepo funcional):

```
Tomá WP-A01 del backlog: monorepo base con pnpm workspaces, Turborepo,
tsconfig compartido, ESLint con eslint-plugin-boundaries y Prettier.

Antes de empezar leé CLAUDE.md, CONTRIBUTING.md, docs/engineering-principles.md
y docs/backlog.md.

Criterio de aceptación: `pnpm install && pnpm typecheck && pnpm lint` en verde.

La regla de fronteras es crítica y no es opcional: packages/domain no puede
importar Prisma, React, ningún framework, fetch, fs, process.env, Date ni
crypto. Configurala de modo que el build FALLE si se viola, y agregá un test
que lo demuestre.

Un PR, solo este paquete. Si el alcance crece, pará y consultá.
```

**Tercera sesión — WP-A03** (objetos de valor), y así sucesivamente siguiendo el orden de dependencias del backlog.

---

## Recomendaciones de uso

**Una sesión, un paquete de trabajo.** El backlog está dimensionado para eso. Sesiones que abarcan tres paquetes producen PRs que nadie puede revisar.

**El orden importa.** El camino crítico es A → B → C → D → E → F. Los bloques A y B son los que hacen que todo lo demás sea rápido: sin `packages/domain` testeado, cada módulo de la API reimplementa el costeo a su manera.

**Empezá cada sesión pidiendo que lea lo que corresponde.** Claude Code carga `CLAUDE.md` solo, pero no los documentos específicos. La primera línea del prompt de cada tarea debería nombrarlos.

**Cuando el agente proponga algo que contradice un ADR**, pedile que cite el ADR y argumente. Si el argumento es bueno, se escribe un ADR nuevo que reemplaza al anterior. Si no lo es, se descarta. Lo que no se hace es ignorarlo en silencio: es así como una arquitectura se desarma sin que nadie decida desarmarla.

**Revisá el dataset dorado con especial cuidado (WP-A10).** Es el único artefacto donde un número equivocado se propaga a todo lo demás sin que ningún test lo detecte, porque los tests miden contra él.
