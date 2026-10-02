import type { ReactNode } from "react";
import type { PermissionCode } from "@joda/contracts";
import { useSession } from "./session";

// Solo presentación. La API vuelve a resolver permisos y deniega el acceso.
export function Can({
  perform,
  children,
  fallback = null,
}: {
  perform: PermissionCode;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const session = useSession();
  return session.data?.permissions.includes(perform) ? children : fallback;
}
