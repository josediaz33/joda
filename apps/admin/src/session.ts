import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { api } from "./api";

export const SESSION_KEY = ["staff-session"] as const;

export function useSession() {
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: api.current,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const isUnauthenticated =
    query.error instanceof TRPCClientError && query.error.data?.httpStatus === 401;

  return { ...query, isUnauthenticated };
}

export function useRefreshSession() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      // Lo que no es la sesión (listas, formularios) era del usuario que sale: se descarta.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
      // La sesión se REINICIA, no se borra (WP-E04b, WP-M24). `queryClient.clear()` la sacaba de la
      // caché y dejaba a `SessionBoundary` observando una consulta huérfana: `invalidateQueries` ya
      // no la encontraba, y solo un re-render de `SessionBoundary` la reponía. Eso pasaba al salir
      // desde el encabezado (el botón es suyo) pero no desde «Verificar segundo factor» ni desde
      // «Inscribir segundo factor»: la cookie quedaba revocada y la pantalla, igual, hasta recargar.
      // `resetQueries` conserva la consulta y su observador, la deja sin datos y la vuelve a pedir:
      // la API responde 401 y el admin muestra el ingreso.
      await queryClient.resetQueries({ queryKey: SESSION_KEY });
    },
  });
}
