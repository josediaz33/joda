import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

const ORDER_INCLUDE = {
  purchase_order_lines: { orderBy: { position: "asc" as const } },
  purchase_order_transitions: { orderBy: { id: "asc" as const } },
} as const;

export type SupplierRow = Prisma.suppliersGetPayload<Record<string, never>>;
export type PurchaseOrderRow = Prisma.purchase_ordersGetPayload<{ include: typeof ORDER_INCLUDE }>;

export const findSupplier = (tx: TenantTx, id: string) => tx.suppliers.findFirst({ where: { id } });
export const listSuppliers = (
  tx: TenantTx,
  input: { cursor?: string; limit: number; isActive?: boolean },
) =>
  tx.suppliers.findMany({
    where: { is_active: input.isActive },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    take: input.limit + 1,
  });
export const createSupplier = (tx: TenantTx, data: Prisma.suppliersUncheckedCreateInput) =>
  tx.suppliers.create({ data });
export const updateSupplier = (
  tx: TenantTx,
  id: string,
  data: Prisma.suppliersUncheckedUpdateInput,
) => tx.suppliers.update({ where: { id }, data });

export const findOrder = (tx: TenantTx, id: string) =>
  tx.purchase_orders.findFirst({ where: { id }, include: ORDER_INCLUDE });
export const listOrders = (
  tx: TenantTx,
  input: {
    cursor?: string;
    limit: number;
    supplierId?: string;
    status?: Prisma.Enumpo_statusFilter["equals"];
  },
) =>
  tx.purchase_orders.findMany({
    where: { supplier_id: input.supplierId, status: input.status },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    take: input.limit + 1,
    include: ORDER_INCLUDE,
  });

export const findVariants = (tx: TenantTx, ids: string[]) =>
  tx.product_variants.findMany({ where: { id: { in: ids } }, select: { id: true, uom: true } });

export async function createOrder(
  tx: TenantTx,
  data: Prisma.purchase_ordersUncheckedCreateInput,
  lines: Omit<Prisma.purchase_order_linesCreateManyInput, "purchase_order_id">[],
) {
  const row = await tx.purchase_orders.create({ data, select: { id: true } });
  await tx.purchase_order_lines.createMany({
    data: lines.map((line) => ({ ...line, purchase_order_id: row.id })),
  });
  return row.id;
}

/** Serializa transiciones concurrentes sobre la misma OC antes de consultar su estado. */
export async function lockOrder(tx: TenantTx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM app.purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
}
export const updateOrderStatus = (
  tx: TenantTx,
  id: string,
  data: Prisma.purchase_ordersUncheckedUpdateInput,
) => tx.purchase_orders.update({ where: { id }, data });
export const insertTransition = (
  tx: TenantTx,
  data: Prisma.purchase_order_transitionsUncheckedCreateInput,
) => tx.purchase_order_transitions.create({ data });
