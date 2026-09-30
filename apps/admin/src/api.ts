import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import {
  listProductsOutput,
  staffSessionCurrentOutput,
  staffSessionProfile,
  mfaEnrollOutput,
  mfaActionOutput,
  staffLogoutOutput,
  staffSessionRefreshOutput,
  type ListProductsInput,
  type StaffLoginInput,
} from "@joda/contracts";

// La cookie __Host-joda_a es httpOnly: fetch la envía, JavaScript nunca la lee.
// En producción la API se publica bajo el mismo host del admin (/trpc).
const trpc = createTRPCUntypedClient({
  links: [
    httpBatchLink({
      url: "/trpc",
      fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
    }),
  ],
});

export const api = {
  current: async () => staffSessionCurrentOutput.parse(await trpc.query("auth.session.current")),
  login: async (input: StaffLoginInput) =>
    staffSessionProfile.parse(await trpc.mutation("auth.session.login", input)),
  refresh: async () => staffSessionRefreshOutput.parse(await trpc.mutation("auth.session.refresh")),
  logout: async () => staffLogoutOutput.parse(await trpc.mutation("auth.session.logout")),
  enroll: async () => mfaEnrollOutput.parse(await trpc.mutation("auth.mfa.enroll")),
  confirmEnroll: async (code: string) =>
    mfaActionOutput.parse(await trpc.mutation("auth.mfa.confirmEnroll", { code })),
  verify: async (code: string) =>
    mfaActionOutput.parse(await trpc.mutation("auth.mfa.verify", { code })),
  listProducts: async (input: ListProductsInput) =>
    listProductsOutput.parse(await trpc.query("catalog.product.list", input)),
};
