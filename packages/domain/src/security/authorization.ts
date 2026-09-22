// Decisión de acceso del middleware de permisos (docs/security-spec.md §3.2,
// WP-C05). No es una regla de negocio del dominio de perfumería (por eso no
// cita un RN-XXX-nn, docs/testing-strategy.md §2.2) — es la misma separación
// que ya usan decideRefreshOutcome (refreshToken.ts) y resolveStaffMfaStatus
// (totp.ts): la DECISIÓN vive acá, pura; apps/api/src/trpc/trpc.ts solo la
// ejecuta.
//
// La regla, de docs/api-conventions.md §4.3 y la trampa de
// docs/runbooks/prompts-playbook.md Sesión 25: sin sesión de personal, 404
// siempre — no distingue "no existe" de "no es tuyo". CON sesión, si el
// usuario no tiene el permiso EXACTO pero sí tiene algún otro permiso del
// mismo módulo (mismo prefijo antes de los ":"), ya sabe que el módulo
// existe — ahí corresponde 403, no 404. Sin ningún permiso de ese módulo,
// sigue siendo 404.
export type PermissionAccessOutcome =
  { readonly kind: "granted" } | { readonly kind: "denied"; readonly httpStatus: 404 | 403 };

function permissionModule(code: string): string {
  return code.slice(0, code.lastIndexOf(":"));
}

export function decidePermissionAccess(input: {
  readonly hasStaffSession: boolean;
  readonly requiredPermission: string;
  readonly grantedPermissions: ReadonlySet<string>;
}): PermissionAccessOutcome {
  const { hasStaffSession, requiredPermission, grantedPermissions } = input;

  if (!hasStaffSession) return { kind: "denied", httpStatus: 404 };
  if (grantedPermissions.has(requiredPermission)) return { kind: "granted" };

  const requiredModule = permissionModule(requiredPermission);
  const hasModuleAccess = Array.from(grantedPermissions).some(
    (granted) => permissionModule(granted) === requiredModule,
  );
  return { kind: "denied", httpStatus: hasModuleAccess ? 403 : 404 };
}
