import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

const ORDER_INCLUDE = {
  purchase_order_lines: { orderBy: { position: "asc" as const } },
  purchase_order_transitions: { orderBy: { id: "asc" as const } },
} as const;

export type SupplierRow = Prisma.suppliersGetPayload<Record<string, never>>;
export type PurchaseOrderRow = Prisma.purchase_ordersGetPayload<{ include: typeof ORDER_INCLUDE }>;

// Las políticas RLS de permisos son permisivas y se combinan con OR; por eso
// cada lectura/escritura de este módulo filtra tenant_id explícitamente.
export const findSupplier = (tx: TenantTx, tenantId: string, id: string) =>
  tx.suppliers.findFirst({ where: { id, tenant_id: tenantId } });
export const listSuppliers = (
  tx: TenantTx,
  input: { tenantId: string; cursor?: string; limit: number; isActive?: boolean },
) =>
  tx.suppliers.findMany({
    where: { tenant_id: input.tenantId, is_active: input.isActive },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    take: input.limit + 1,
  });
export const createSupplier = (tx: TenantTx, data: Prisma.suppliersUncheckedCreateInput) =>
  tx.suppliers.create({ data });
export const updateSupplier = (
  tx: TenantTx,
  tenantId: string,
  id: string,
  data: Prisma.suppliersUncheckedUpdateInput,
) => tx.suppliers.update({ where: { id, tenant_id: tenantId }, data });

export const findOrder = (tx: TenantTx, tenantId: string, id: string) =>
  tx.purchase_orders.findFirst({ where: { id, tenant_id: tenantId }, include: ORDER_INCLUDE });
export const listOrders = (
  tx: TenantTx,
  input: {
    tenantId: string;
    cursor?: string;
    limit: number;
    supplierId?: string;
    status?: Prisma.Enumpo_statusFilter["equals"];
  },
) =>
  tx.purchase_orders.findMany({
    where: { tenant_id: input.tenantId, supplier_id: input.supplierId, status: input.status },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    take: input.limit + 1,
    include: ORDER_INCLUDE,
  });

export const findVariants = (tx: TenantTx, tenantId: string, ids: string[]) =>
  tx.product_variants.findMany({
    where: { id: { in: ids }, tenant_id: tenantId },
    select: { id: true, uom: true },
  });

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
export async function lockOrder(tx: TenantTx, tenantId: string, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM app.purchase_orders WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
}
export const updateOrderStatus = (
  tx: TenantTx,
  tenantId: string,
  id: string,
  data: Prisma.purchase_ordersUncheckedUpdateInput,
) => tx.purchase_orders.update({ where: { id, tenant_id: tenantId }, data });
export const insertTransition = (
  tx: TenantTx,
  data: Prisma.purchase_order_transitionsUncheckedCreateInput,
) => tx.purchase_order_transitions.create({ data });
