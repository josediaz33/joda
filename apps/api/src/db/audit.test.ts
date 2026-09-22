import { PrismaClient } from "@joda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAuditEntry } from "./audit.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "./testDb.js";
import { withTenantTx } from "./withTenantTx.js";

const TENANT_ID = "77777777-7777-4777-a777-777777777777";
const OTHER_TENANT_ID = "55555555-5555-4555-a555-555555555555";
const ACTOR = {
  userId: "88888888-8888-4888-a888-888888888888",
  tenantId: TENANT_ID,
  audience: "staff" as const,
};

// docs/api-conventions.md §10 y docs/security-spec.md §7 (WP-C07): el
// mecanismo de escritura de `audit_log`, no un módulo de negocio concreto —
// "no hace falta instrumentar módulos que todavía no existen" (inventario y
// contabilidad recién llegan en WP-C10+), así que estas pruebas ejercitan
// `recordAuditEntry` con acciones con forma de esas dos áreas, contra
// Postgres real vía Testcontainers (.claude/rules/testing.md), no un
// simulacro de Prisma. `audit_log` no tiene FK a `tenants` (a diferencia de
// `idempotency_keys`, packages/db/migrations/0002_identity_rbac.sql), así
// que a diferencia de withIdempotentTx.test.ts no hace falta sembrar un
// tenant — la política RLS `tenant_isolation` solo compara contra
// `app.current_tenant_id()`, que `withTenantTx` ya deja en contexto.
describe("recordAuditEntry (docs/api-conventions.md §10, docs/security-spec.md §7, WP-C07)", () => {
  let testDb: TestDb;
  let db: PrismaClient;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
    await testDb.stop();
  });

  it("una mutación de inventario queda registrada con los campos fijos, en la misma transacción que el efecto", async () => {
    const movementId = "99999999-9999-4999-a999-999999999999";

    await withTenantTx(db, ACTOR, (tx) =>
      recordAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: ACTOR.userId,
        audience: "staff",
        action: "inventory.adjustment.create",
        entity: "inventory_movements",
        entityId: movementId,
        before: null,
        after: { qty: "-5.000", reason: "rotura" },
        ip: "203.0.113.10",
        userAgent: "vitest/audit-c07",
        requestId: "req-inventory-1",
      }),
    );

    const { rows } = await testDb.superuserClient.query(
      `SELECT tenant_id, actor_id, audience, action, entity, entity_id, before, after,
              ip, user_agent, request_id, occurred_at
         FROM app.audit_log WHERE action = $1`,
      ["inventory.adjustment.create"],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_ID,
      actor_id: ACTOR.userId,
      audience: "staff",
      action: "inventory.adjustment.create",
      entity: "inventory_movements",
      entity_id: movementId,
      before: null,
      after: { qty: "-5.000", reason: "rotura" },
      ip: "203.0.113.10",
      user_agent: "vitest/audit-c07",
      request_id: "req-inventory-1",
    });
    expect(rows[0].occurred_at).toBeInstanceOf(Date);
  });

  it("una mutación de contabilidad queda registrada — el mecanismo no es específico de inventario", async () => {
    const entryId = "66666666-6666-4666-a666-666666666666";

    await withTenantTx(db, ACTOR, (tx) =>
      recordAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: ACTOR.userId,
        audience: "staff",
        action: "accounting.journal.create",
        entity: "journal_entries",
        entityId: entryId,
        before: null,
        after: { debit: "150000", credit: "150000" },
        ip: null,
        userAgent: null,
        requestId: "req-accounting-1",
      }),
    );

    const { rows } = await testDb.superuserClient.query(
      `SELECT tenant_id, action, entity, entity_id, after
         FROM app.audit_log WHERE action = $1`,
      ["accounting.journal.create"],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_ID,
      action: "accounting.journal.create",
      entity: "journal_entries",
      entity_id: entryId,
      after: { debit: "150000", credit: "150000" },
    });
  });

  // docs/testing-strategy.md §3.2: "obligatoria y explícita" — conectada como
  // `joda_api` (nunca el superusuario del contenedor), sin tenant_id en
  // contexto no ve nada, y con OTRO tenant en contexto tampoco. Es la prueba
  // que detecta si alguien cambió la conexión a una credencial elevada y
  // desactivó en silencio toda la capa de aislamiento (RLS `tenant_isolation`,
  // packages/db/migrations/0010_security_rls.sql).
  it("RLS aísla audit_log por tenant con el rol de aplicación (docs/testing-strategy.md §3.2)", async () => {
    const action = "inventory.rls-isolation-test";

    await withTenantTx(db, ACTOR, (tx) =>
      recordAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: ACTOR.userId,
        audience: "staff",
        action,
        entity: "inventory_movements",
        entityId: null,
        before: null,
        after: null,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    );

    // Sin tenant_id en contexto, `app.current_tenant_id()` es NULL — la
    // política `tenant_id = app.current_tenant_id()` nunca es verdadera
    // contra NULL, así que ni siquiera ve la fila que acaba de escribir el
    // test anterior en esta misma conexión reciclada (jodaApiConnectionUrl,
    // connection_limit=1).
    const withoutTenantContext = await db.$transaction((tx) =>
      tx.audit_log.findMany({ where: { action } }),
    );
    expect(withoutTenantContext).toHaveLength(0);

    // Con un tenant DISTINTO en contexto, tampoco ve la fila de TENANT_ID.
    const otherTenantRows = await withTenantTx(
      db,
      { userId: ACTOR.userId, tenantId: OTHER_TENANT_ID, audience: "staff" },
      (tx) => tx.audit_log.findMany({ where: { action } }),
    );
    expect(otherTenantRows).toHaveLength(0);

    // Contraste: con el tenant correcto sí la ve — la ausencia de arriba es
    // aislamiento, no un bug que esconda la fila para cualquiera.
    const ownTenantRows = await withTenantTx(db, ACTOR, (tx) =>
      tx.audit_log.findMany({ where: { action } }),
    );
    expect(ownTenantRows).toHaveLength(1);
  });

  it("si la transacción hace rollback después de auditar, la fila no queda persistida — no es un paso aparte que pueda desincronizarse", async () => {
    const action = "inventory.rollback-test";

    await expect(
      withTenantTx(db, ACTOR, async (tx) => {
        await recordAuditEntry(tx, {
          tenantId: TENANT_ID,
          actorId: ACTOR.userId,
          audience: "staff",
          action,
          entity: "inventory_movements",
          entityId: null,
          before: null,
          after: null,
          ip: null,
          userAgent: null,
          requestId: null,
        });
        throw new Error("el efecto de negocio falló después de auditar");
      }),
    ).rejects.toThrow("el efecto de negocio falló después de auditar");

    const { rows } = await testDb.superuserClient.query(
      `SELECT 1 FROM app.audit_log WHERE action = $1`,
      [action],
    );
    expect(rows).toHaveLength(0);
  });

  it("before/after en null se guardan como SQL NULL, no como el literal JSON null", async () => {
    const action = "inventory.null-json-test";

    await withTenantTx(db, ACTOR, (tx) =>
      recordAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: null,
        audience: "system",
        action,
        entity: "inventory_movements",
        entityId: null,
        before: null,
        after: null,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    );

    const { rows } = await testDb.superuserClient.query(
      `SELECT before IS NULL AS before_is_sql_null, jsonb_typeof(before) AS before_type,
              after IS NULL AS after_is_sql_null, jsonb_typeof(after) AS after_type
         FROM app.audit_log WHERE action = $1`,
      [action],
    );

    expect(rows[0]).toEqual({
      before_is_sql_null: true,
      before_type: null,
      after_is_sql_null: true,
      after_type: null,
    });
  });
});
