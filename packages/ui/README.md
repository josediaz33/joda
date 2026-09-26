# Primitivas compartidas

`components.json` y el alias `@ui/*` de los tres `tsconfig.json` dirigen las
primitivas de shadcn/Radix a `src/primitives/`. Admin y storefront apuntan al
mismo paquete; las composiciones de producto permanecen en cada app. Para
agregar una primitiva desde la raíz:

```bash
pnpm dlx shadcn@latest add <nombre> --cwd packages/ui
```

Revisá el `--dry-run` antes de agregarla: el destino debe estar dentro de
`packages/ui/src/primitives/`. El CLI puede proponer tokens de su paleta;
conservá los alias a los roles existentes en `src/styles/tokens.css`.

El alias de TypeScript evita que el CLI recorte la ruta de usuario de Windows
al resolver `package.json#imports`. `npx shadcn@latest add button --dry-run`
apunta a `packages/ui/src/primitives/` desde el paquete y desde ambas apps,
sin unidad `subst`. Los consumidores importan desde `@joda/ui/primitives/*`.

El CLI no puede instalar dependencias con `npm` en este monorepo porque usa
`catalog:`. Si propone una dependencia nueva, agregala primero con
`pnpm --filter @joda/ui add -E <dependencia>` y después repetí el comando.

`PopoverContent` requiere un `aria-label` no vacío para nombrar el diálogo que
monta Radix. `PopoverTitle` renderiza un encabezado `h2` para el título visible.

`tokens.test.mjs` permanece en `node:test` porque solo verifica CSS. La prueba
de comportamiento de `Popover` usa Vitest y un DOM simulado.
