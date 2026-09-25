# Primitivas compartidas

`components.json` dirige las primitivas de shadcn/Radix a `src/primitives/`.
Admin y storefront apuntan al mismo paquete; las composiciones de producto
permanecen en cada app. Para agregar una primitiva:

```bash
pnpm dlx shadcn@latest add <nombre> --cwd packages/ui
```

Revisá el `--dry-run` antes de agregarla: el destino debe estar dentro de
`packages/ui/src/primitives/`. El CLI puede proponer tokens de su paleta;
conservá los alias a los roles existentes en `src/styles/tokens.css`.

En Windows, el CLI actual resuelve mal `package.json#imports` cuando la ruta
del usuario contiene un punto (como `jose.diaz.ITAPUA`): recorta el destino a
`C:\Users\jose`. En ese caso, montá temporalmente el repositorio en una letra
libre con `subst`, ejecutá el CLI desde esa ruta y desmontá la letra al final:

```powershell
subst J: C:\Users\jose.diaz.ITAPUA\Desktop\joda-codex-ui
pnpm dlx shadcn@latest add <nombre> --cwd J:\packages\ui --dry-run
pnpm dlx shadcn@latest add <nombre> --cwd J:\packages\ui
subst J: /D
```

El CLI no puede instalar dependencias con `npm` en este monorepo porque usa
`catalog:`. Si propone una dependencia nueva, agregala primero con
`pnpm --filter @joda/ui add -E <dependencia>` y después repetí el comando.

`tokens.test.mjs` permanece en `node:test`: solo verifica el CSS y no necesita
dependencias de React ni un runner adicional. Se evaluó el paso a Vitest en
WP-E02 y no aportaría cobertura nueva.
