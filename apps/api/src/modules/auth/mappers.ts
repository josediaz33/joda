import type { StaffMfaStatus } from "@joda/domain";
import type { StaffSessionProfile } from "@joda/contracts";
import type { StaffUserProfileRow } from "./repository.js";

// Capa anticorrupción (docs/engineering-principles.md Parte III): la fila de
// `staff_users` no es el DTO de la API — acá no importa mucho hoy (los
// nombres ya coinciden), pero es el único lugar donde login/refresh
// deberían tener que cambiar si el día de mañana el perfil expuesto agrega
// un campo que no es 1:1 con una columna. `mfaStatus` (WP-C04) no sale de
// `staff_users` directo — es el estado ya resuelto de la sesión, no una
// columna.
export function toStaffSessionProfile(
  row: StaffUserProfileRow,
  mfaStatus: StaffMfaStatus,
): StaffSessionProfile {
  return { id: row.id, email: row.email, fullName: row.fullName, mfaStatus };
}
