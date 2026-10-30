import pg from "pg";
import { DEV_TENANT } from "./devUsers.mjs";

// Lo que el entorno local necesita de Postgres y que NO es una migración
// (WP-M18): roles y bases del Auth local, la contraseña de `joda_api`, el tenant
// de desarrollo con su personal y el stock recibido. Todo corre como
// superusuario (DATABASE_URL), una sola vez, desde `pnpm dev:setup` — nunca el
// runtime de la API, que conecta como `joda_api`.

const HEX = /^[0-9a-f]{16,}$/;

/**
 * Un DDL (`ALTER ROLE ... PASSWORD`) no admite parámetros. Los secretos de
 * `.env.local` son hex generado por nosotros; si no lo fueran, se corta acá en
 * vez de armar SQL con texto ajeno.
 *
 * @param {string} secret
 */
function hexLiteral(secret) {
  if (!HEX.test(secret)) {
    throw new Error("Se esperaba un secreto hexadecimal generado por `pnpm dev:setup`.");
  }
  return `'${secret}'`;
}

/**
 * @template T
 * @param {string} connectionString
 * @param {(client: pg.Client) => Promise<T>} fn
 */
export async function withSuperuser(connectionString, fn) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** @param {string} databaseUrl la URL del superusuario, con la base `joda` */
function withDatabase(databaseUrl, database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * La base `gotrue` y el rol `supabase_auth_admin` que usa el Auth local, dentro
 * del mismo Postgres. Idempotente. El `search_path = auth` del rol es lo que
 * GoTrue espera (es como lo deja Supabase): sin él, sus migraciones crean las
 * tablas pero algunas consultas no las encuentran.
 *
 * @param {string} databaseUrl
 * @param {string} password
 */
export async function ensureAuthDatabase(databaseUrl, password) {
  const literal = hexLiteral(password);
  await withSuperuser(databaseUrl, async (client) => {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
          CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
        END IF;
      END $$;
    `);
    await client.query(`ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD ${literal}`);
    await client.query("ALTER ROLE supabase_auth_admin SET search_path TO auth");
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'gotrue'");
    if (exists.rowCount === 0) {
      await client.query("CREATE DATABASE gotrue OWNER supabase_auth_admin");
    }
  });
  await withSuperuser(withDatabase(databaseUrl, "gotrue"), (client) =>
    client.query("CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin"),
  );
}

/**
 * `db:reset` deja a `joda_api` con la contraseña fija del seed de las pruebas
 * (seed/0002_seed_joda_api_credential.sql). En el Postgres local se reemplaza
 * por la de `.env.local`, al azar por máquina. Es un ALTER ROLE del setup, no
 * una migración: a un esquema no le corresponde fijar un secreto.
 *
 * @param {string} databaseUrl
 * @param {string} password
 */
export async function setApiRolePassword(databaseUrl, password) {
  const literal = hexLiteral(password);
  await withSuperuser(databaseUrl, (client) =>
    client.query(`ALTER ROLE joda_api WITH LOGIN PASSWORD ${literal}`),
  );
}

/**
 * El tenant JODA y su personal, con las mismas funciones de siembra que usa la
 * base (plan de cuentas, roles y permisos, reglas de posteo). No hay una API
 * que cree el primer usuario —quien la llama necesita ya una sesión—, así que
 * este es el único tramo del seed que va por SQL directo (registrado en
 * docs/runbooks/entorno-local.md y en el PR de WP-M18).
 *
 * @param {string} databaseUrl
 * @param {ReadonlyArray<{ role: string; email: string; fullName: string; authSubject: string }>} staff
 * @returns {Promise<{ tenantId: string; staffIds: Record<string, string> }>}
 */
export async function seedTenantAndStaff(databaseUrl, staff) {
  return withSuperuser(databaseUrl, async (client) => {
    // Las funciones de siembra usan nombres sin esquema, como el seed (0001_seed_base.sql).
    await client.query("SET search_path = app, public");
    await client.query("BEGIN");
    try {
      const tenant = await client.query(
        `INSERT INTO app.tenants (slug, legal_name, trade_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET trade_name = EXCLUDED.trade_name
         RETURNING id`,
        [DEV_TENANT.slug, DEV_TENANT.legalName, DEV_TENANT.tradeName],
      );
      const tenantId = tenant.rows[0].id;
      await client.query("SELECT app.seed_chart_of_accounts($1)", [tenantId]);
      await client.query("SELECT app.seed_roles($1)", [tenantId]);
      await client.query("SELECT app.seed_posting_rules($1)", [tenantId]);

      /** @type {Record<string, string>} */
      const staffIds = {};
      for (const member of staff) {
        const row = await client.query(
          `INSERT INTO app.staff_users (tenant_id, auth_subject, email, full_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, email) DO UPDATE
             SET auth_subject = EXCLUDED.auth_subject,
                 full_name = EXCLUDED.full_name,
                 is_active = true
           RETURNING id`,
          [tenantId, member.authSubject, member.email, member.fullName],
        );
        const staffUserId = row.rows[0].id;
        staffIds[member.role] = staffUserId;
        await client.query(
          `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id)
           SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = $3
           ON CONFLICT DO NOTHING`,
          [tenantId, staffUserId, member.role],
        );
      }
      await client.query("COMMIT");
      return { tenantId, staffIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Stock recibido de los datos de muestra. NO hay API que reciba mercadería
 * todavía (WP-C15, recepciones con prorrateo, está pendiente), así que los lotes
 * se insertan igual que los inserta la suite de integración de apps/api: el lote
 * y su movimiento `purchase_receipt`; el saldo lo proyecta el trigger. Cuando
 * exista C15, este tramo pasa a ser una llamada a la API.
 *
 * Idempotente por `lot_code`.
 *
 * @param {string} databaseUrl
 * @param {{ tenantId: string; createdBy: string; lots: ReadonlyArray<{
 *   lotCode: string; sku: string; qty: number; uom: "unit" | "ml";
 *   unitCostMinor: number; currency: string; fxRateToPyg: number; unitLandedCostPyg: number;
 * }> }} input
 * @returns {Promise<Record<string, string>>} id de lote por `lotCode`
 */
export async function seedReceivedLots(databaseUrl, { tenantId, createdBy, lots }) {
  return withSuperuser(databaseUrl, async (client) => {
    /** @type {Record<string, string>} */
    const ids = {};
    for (const lot of lots) {
      const existing = await client.query(
        "SELECT id FROM app.inventory_lots WHERE tenant_id = $1 AND lot_code = $2",
        [tenantId, lot.lotCode],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        ids[lot.lotCode] = existing.rows[0].id;
        continue;
      }
      const variant = await client.query(
        "SELECT id FROM app.product_variants WHERE tenant_id = $1 AND sku = $2",
        [tenantId, lot.sku],
      );
      if (variant.rowCount === 0) {
        throw new Error(`No existe la variante ${lot.sku}: el catálogo de muestra no se creó.`);
      }
      const variantId = variant.rows[0].id;
      const landedTotal = lot.unitLandedCostPyg * lot.qty;

      await client.query("BEGIN");
      try {
        const inserted = await client.query(
          `INSERT INTO app.inventory_lots
             (tenant_id, variant_id, lot_code, qty_initial, uom,
              unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            tenantId,
            variantId,
            lot.lotCode,
            lot.qty,
            lot.uom,
            lot.unitCostMinor,
            lot.currency,
            lot.fxRateToPyg,
            landedTotal,
            lot.unitLandedCostPyg,
          ],
        );
        const lotId = inserted.rows[0].id;
        await client.query(
          `INSERT INTO app.inventory_movements
             (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg,
              reference_type, created_by, note)
           VALUES ($1, $2, $3, $4, $5, 'purchase_receipt', $6, 'dev_seed', $7,
                   'Stock de muestra del entorno local (WP-M18)')`,
          [tenantId, lotId, variantId, lot.qty, lot.uom, landedTotal, createdBy],
        );
        await client.query("COMMIT");
        ids[lot.lotCode] = lotId;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return ids;
  });
}

/** @param {string} databaseUrl */
export async function findTenantId(databaseUrl) {
  return withSuperuser(databaseUrl, async (client) => {
    const result = await client.query("SELECT id FROM app.tenants WHERE slug = $1", [
      DEV_TENANT.slug,
    ]);
    return result.rows[0]?.id ?? null;
  });
}

/**
 * @param {string} databaseUrl
 * @param {string} tenantId
 * @param {string} email
 */
export async function findStaffId(databaseUrl, tenantId, email) {
  return withSuperuser(databaseUrl, async (client) => {
    const result = await client.query(
      "SELECT id FROM app.staff_users WHERE tenant_id = $1 AND email = $2",
      [tenantId, email],
    );
    return result.rows[0]?.id ?? null;
  });
}
