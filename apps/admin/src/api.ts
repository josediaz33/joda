import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import {
  listProductsOutput,
  adminProductSchema,
  adminVariantSchema,
  listCategoriesOutput,
  adminCategorySchema,
  adminMediaSchema,
  staffSessionCurrentOutput,
  staffSessionProfile,
  mfaEnrollOutput,
  mfaActionOutput,
  staffLogoutOutput,
  staffSessionRefreshOutput,
  type ListProductsInput,
  type CreateProductInput,
  type UpdateProductInput,
  type CreateVariantInput,
  type CreateCategoryInput,
  type UpdateCategoryInput,
  type SetProductPublicationInput,
  type SetVariantVisibilityInput,
  type UpdateVariantInput,
  type StaffLoginInput,
} from "@joda/contracts";

// La cookie __Host-joda_a es httpOnly: fetch la envía, JavaScript nunca la lee.
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
  listCategories: async (cursor?: string) =>
    listCategoriesOutput.parse(await trpc.query("catalog.category.list", { cursor, limit: 200 })),
  createCategory: async (input: CreateCategoryInput) =>
    adminCategorySchema.parse(await trpc.mutation("catalog.category.create", input)),
  updateCategory: async (input: UpdateCategoryInput) =>
    adminCategorySchema.parse(await trpc.mutation("catalog.category.update", input)),
  publishProduct: async (input: SetProductPublicationInput) =>
    adminProductSchema.parse(await trpc.mutation("catalog.product.publish", input)),
  unpublishProduct: async (input: SetProductPublicationInput) =>
    adminProductSchema.parse(await trpc.mutation("catalog.product.unpublish", input)),
  setVariantVisibility: async (input: SetVariantVisibilityInput) =>
    adminVariantSchema.parse(await trpc.mutation("catalog.variant.setVisibility", input)),
  createProduct: async (input: CreateProductInput) =>
    adminProductSchema.parse(await trpc.mutation("catalog.product.create", input)),
  updateProduct: async (input: UpdateProductInput) =>
    adminProductSchema.parse(await trpc.mutation("catalog.product.update", input)),
  createVariant: async (input: CreateVariantInput) =>
    adminVariantSchema.parse(await trpc.mutation("catalog.variant.create", input)),
  updateVariant: async (input: UpdateVariantInput) =>
    adminVariantSchema.parse(await trpc.mutation("catalog.variant.update", input)),
  uploadProductMedia: async (input: { productId: string; file: File; altText: string }) => {
    const body = new FormData();
    // C09 lee los campos al recibir el archivo: deben preceder a `file`.
    body.append("productId", input.productId);
    body.append("altText", input.altText);
    body.append("file", input.file);
    const response = await fetch("/media/products", {
      method: "POST",
      body,
      credentials: "include",
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof result === "object" && result !== null && "message" in result
          ? String(result.message)
          : "No se pudo subir la imagen.";
      throw new Error(message);
    }
    return adminMediaSchema.parse(result);
  },
};
