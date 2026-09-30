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
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}
