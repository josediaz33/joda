import { findStaffId, findTenantId, seedReceivedLots } from "./database.mjs";
import { DEV_USERS, devUserFor } from "./devUsers.mjs";
import { log } from "./process.mjs";
import { createTrpcClient, signInWithMfa } from "./trpcClient.mjs";

// Datos de muestra del entorno local (WP-M18). Todo lo que la API puede crear
// se crea POR LA API —HTTP + tRPC, con la sesión del dueño—, así pasa por su
// autorización, RLS, auditoría y reglas de dominio. Dos tramos no tienen API
// todavía y se siembran por SQL, el mecanismo más fiel disponible, registrados
// en docs/runbooks/entorno-local.md:
//   - el tenant y el personal (no hay quien llame a la API sin un usuario);
//   - el stock recibido (WP-C15, recepciones, está pendiente).
// Re-ejecutable: cada paso busca antes de crear.

const USD_FX = 7300;

/**
 * @typedef {{ ml: number; pricePyg: string }} DecantSize
 * @typedef {{
 *   slug: string; name: string; concentration: string; nominalVolumeMl: number;
 *   family: string; top: string[]; heart: string[]; base: string[];
 *   sku: string; sealedPricePyg: string; decants: DecantSize[]; publish: boolean;
 *   stock: { qty: number; unitCostUsdMinor: number; unitLandedCostPyg: number };
 * }} PerfumeSpec
 */

/** @type {readonly PerfumeSpec[]} */
const PERFUMES = [
  {
    slug: "layton",
    name: "Layton — Parfums de Marly",
    concentration: "edp",
    nominalVolumeMl: 125,
    family: "oriental especiado",
    top: ["manzana", "lavanda", "bergamota"],
    heart: ["geranio", "violeta", "jazmín"],
    base: ["vainilla", "cardamomo", "sándalo"],
    sku: "LAYTON",
    sealedPricePyg: "1450000",
    decants: [
      { ml: 5, pricePyg: "95000" },
      { ml: 10, pricePyg: "175000" },
      { ml: 30, pricePyg: "480000" },
    ],
    publish: true,
    stock: { qty: 6, unitCostUsdMinor: 14000, unitLandedCostPyg: 1_075_000 },
  },
  {
    slug: "aventus",
    name: "Aventus — Creed",
    concentration: "edp",
    nominalVolumeMl: 100,
    family: "chipre frutal",
    top: ["piña", "bergamota", "grosella negra"],
    heart: ["abedul", "rosa", "jazmín"],
    base: ["almizcle", "musgo de roble", "ámbar gris"],
    sku: "AVENTUS",
    sealedPricePyg: "2150000",
    decants: [
      { ml: 5, pricePyg: "130000" },
      { ml: 10, pricePyg: "240000" },
    ],
    publish: false,
    stock: { qty: 4, unitCostUsdMinor: 21500, unitLandedCostPyg: 1_650_000 },
  },
  {
    slug: "baccarat-rouge-540",
    name: "Baccarat Rouge 540 — Maison Francis Kurkdjian",
    concentration: "extrait",
    nominalVolumeMl: 70,
    family: "ámbar floral",
    top: ["azafrán", "jazmín"],
    heart: ["ámbar gris", "cedro"],
    base: ["resina de abeto", "almizcle"],
    sku: "BR540",
    sealedPricePyg: "2450000",
    decants: [{ ml: 10, pricePyg: "290000" }],
    publish: false,
    stock: { qty: 3, unitCostUsdMinor: 19000, unitLandedCostPyg: 1_450_000 },
  },
];

const WATCH = {
  slug: "casio-f91w",
  name: "Casio F-91W",
  sku: "CASIO-F91W",
  pricePyg: "250000",
  serials: ["F91W-DEV-0001", "F91W-DEV-0002", "F91W-DEV-0003"],
  stock: { qty: 3, unitCostUsdMinor: 1200, unitLandedCostPyg: 105_000 },
};

/**
 * @param {ReturnType<typeof createTrpcClient>} client
 * @param {string} path
 * @param {Record<string, unknown>} [input]
 */
async function listAll(client, path, input = {}) {
  /** @type {any[]} */
  const items = [];
  let cursor;
  do {
    const page = await client.query(path, { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/**
 * @param {{ apiUrl: string; databaseUrl: string }} config
 */
export async function seedSampleData({ apiUrl, databaseUrl }) {
  // El segundo factor es obligatorio para todo el personal (WP-C04): se inscribe el de los
  // cuatro usuarios de prueba por la API, y el secreto que devuelve cada inscripción queda
  // en .data/dev/ para `pnpm dev:totp` y para el humo de Playwright.
  for (const user of DEV_USERS) {
    await signInWithMfa(createTrpcClient(apiUrl), user);
  }
  log(`segundo factor inscripto para: ${DEV_USERS.map((user) => user.role).join(", ")}`);

  const owner = devUserFor("owner");
  const client = createTrpcClient(apiUrl);
  await signInWithMfa(client, owner);

  // --- Catálogo --------------------------------------------------------
  const categories = await listAll(client, "catalog.category.list");
  /** @param {string} slug @param {string} name */
  async function ensureCategory(slug, name) {
    const found = categories.find((category) => category.slug === slug);
    if (found) return found.id;
    const created = await client.mutation("catalog.category.create", { slug, name });
    log(`categoría creada: ${name}`);
    return created.id;
  }
  const perfumesCategoryId = await ensureCategory("perfumes", "Perfumes");
  const watchesCategoryId = await ensureCategory("relojes", "Relojes");

  const products = await listAll(client, "catalog.product.list");
  /** @type {Record<string, string>} variantId por SKU */
  const variantIds = {};
  /** @type {Record<string, string>} productId por slug */
  const productIds = {};

  /**
   * @param {string} productId
   * @param {Array<Record<string, unknown> & { sku: string }>} wanted
   */
  async function ensureVariants(productId, wanted) {
    const existing = await client.query("catalog.variant.list", { productId });
    for (const spec of wanted) {
      const found = existing.find(
        (/** @type {{ sku: string }} */ variant) => variant.sku === spec.sku,
      );
      if (found) {
        variantIds[spec.sku] = found.id;
        continue;
      }
      const created = await client.mutation("catalog.variant.create", { productId, ...spec });
      variantIds[spec.sku] = created.id;
      log(`variante creada: ${spec.sku}`);
    }
  }

  for (const perfume of PERFUMES) {
    let product = products.find((candidate) => candidate.slug === perfume.slug);
    if (!product) {
      product = await client.mutation("catalog.product.create", {
        kind: "perfume",
        slug: perfume.slug,
        name: perfume.name,
        description: `${perfume.name}. Dato de muestra del entorno local.`,
        categoryIds: [perfumesCategoryId],
        primaryCategoryId: perfumesCategoryId,
        perfumeDetails: {
          concentration: perfume.concentration,
          nominalVolumeMl: perfume.nominalVolumeMl,
          olfactoryFamily: perfume.family,
          notesTop: perfume.top,
          notesHeart: perfume.heart,
          notesBase: perfume.base,
          isDecantable: true,
          wasteFactor: 0.02,
          unusableResidueMl: 2,
          evaporationMlYear: 0.5,
        },
      });
      log(`perfume creado: ${perfume.name}`);
    }
    productIds[perfume.slug] = product.id;

    // El granel primero: los decants bajo pedido declaran de cuál salen.
    await ensureVariants(product.id, [
      {
        sku: `${perfume.sku}-${perfume.nominalVolumeMl}`,
        variantType: "sealed",
        uom: "unit",
        sizeMl: perfume.nominalVolumeMl,
        pricePyg: perfume.sealedPricePyg,
      },
      {
        sku: `${perfume.sku}-GRANEL`,
        variantType: "bulk",
        uom: "ml",
        sizeMl: null,
        pricePyg: "0",
      },
    ]);
    await ensureVariants(
      product.id,
      perfume.decants.map((decant) => ({
        sku: `${perfume.sku}-DECANT-${decant.ml}`,
        variantType: "decant",
        uom: "ml",
        sizeMl: decant.ml,
        pricePyg: decant.pricePyg,
        productionMode: "made_to_order",
        sourceVariantId: variantIds[`${perfume.sku}-GRANEL`],
      })),
    );
  }

  // Reloj serializado: un Casio, con número de serie por unidad (RN-SER).
  let watch = products.find((candidate) => candidate.slug === WATCH.slug);
  if (!watch) {
    watch = await client.mutation("catalog.product.create", {
      kind: "watch",
      slug: WATCH.slug,
      name: WATCH.name,
      description: "Reloj digital clásico. Dato de muestra del entorno local.",
      categoryIds: [watchesCategoryId],
      primaryCategoryId: watchesCategoryId,
      watchDetails: {
        movement: "quartz",
        caseMaterial: "Resina",
        caseDiameterMm: 33.2,
        waterResistanceM: 30,
        strapMaterial: "Resina",
        crystal: "Resina",
        warrantyMonths: 12,
        requiresSerial: true,
      },
    });
    log(`reloj creado: ${WATCH.name}`);
  }
  productIds[WATCH.slug] = watch.id;
  await ensureVariants(watch.id, [
    {
      sku: WATCH.sku,
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: WATCH.pricePyg,
      isSerialized: true,
      allocationPolicy: "serial",
    },
  ]);

  // Activar los borradores; publicar solo Layton (con sus variantes visibles), así
  // el admin muestra los tres estados: publicado, activo sin publicar y borrador.
  const current = await listAll(client, "catalog.product.list");
  for (const [slug, id] of Object.entries(productIds)) {
    if (current.find((product) => product.id === id)?.status === "draft") {
      await client.mutation("catalog.product.activate", { id });
      log(`producto activado: ${slug}`);
    }
  }
  for (const perfume of PERFUMES.filter((candidate) => candidate.publish)) {
    // Publicar exige al menos una variante visible con precio (RF-CAT-09): primero la visibilidad.
    for (const sku of [
      `${perfume.sku}-${perfume.nominalVolumeMl}`,
      ...perfume.decants.map((decant) => `${perfume.sku}-DECANT-${decant.ml}`),
    ]) {
      await client.mutation("catalog.variant.setVisibility", {
        id: variantIds[sku],
        onlineVisible: true,
      });
    }
    await client.mutation("catalog.product.publish", { id: productIds[perfume.slug] });
  }

  // --- Compras ---------------------------------------------------------
  const suppliers = await listAll(client, "market.supplier.list");
  let supplier = suppliers.find((candidate) => candidate.code === "SUP-DEV-01");
  if (!supplier) {
    supplier = await client.mutation("market.supplier.create", {
      code: "SUP-DEV-01",
      name: "Distribuidora Oriente (desarrollo)",
      country: "AE",
      defaultCurrency: "USD",
      paymentTermsDays: 30,
      leadTimeDays: 21,
      notes: "Proveedor de muestra del entorno local.",
    });
    log("proveedor creado: SUP-DEV-01");
  }

  const orders = await listAll(client, "market.purchaseOrder.list", { supplierId: supplier.id });
  if (!orders.some((order) => order.code === "OC-DEV-0001")) {
    const order = await client.mutation("market.purchaseOrder.create", {
      supplierId: supplier.id,
      code: "OC-DEV-0001",
      currency: "USD",
      fxRateToPyg: String(USD_FX),
      freightMinor: "35000",
      customsMinor: "0",
      otherCostsMinor: "0",
      freightMethod: "by_value",
      notes: "Orden de muestra del entorno local: reposición de Layton y Aventus.",
      lines: [
        {
          variantId: variantIds["LAYTON-125"],
          qtyOrdered: "6",
          uom: "unit",
          unitPriceMinor: "14000",
        },
        {
          variantId: variantIds["AVENTUS-100"],
          qtyOrdered: "4",
          uom: "unit",
          unitPriceMinor: "21500",
        },
      ],
    });
    await client.mutation("market.purchaseOrder.transition", {
      id: order.id,
      toStatus: "pending_approval",
    });
    await client.mutation("market.purchaseOrder.approve", { id: order.id });
    await client.mutation("market.purchaseOrder.transition", { id: order.id, toStatus: "sent" });
    log("orden de compra creada y enviada: OC-DEV-0001");
  }

  // --- Stock recibido (SQL: la API todavía no recibe mercadería, WP-C15) -------
  const tenantId = await findTenantId(databaseUrl);
  const ownerStaffId = await findStaffId(databaseUrl, tenantId, owner.email);
  const lots = await seedReceivedLots(databaseUrl, {
    tenantId,
    createdBy: ownerStaffId,
    lots: [
      ...PERFUMES.map((perfume) => ({
        lotCode: `DEV-${perfume.sku}-01`,
        sku: `${perfume.sku}-${perfume.nominalVolumeMl}`,
        qty: perfume.stock.qty,
        uom: /** @type {const} */ ("unit"),
        unitCostMinor: perfume.stock.unitCostUsdMinor,
        currency: "USD",
        fxRateToPyg: USD_FX,
        unitLandedCostPyg: perfume.stock.unitLandedCostPyg,
      })),
      {
        lotCode: "DEV-CASIO-01",
        sku: WATCH.sku,
        qty: WATCH.stock.qty,
        uom: /** @type {const} */ ("unit"),
        unitCostMinor: WATCH.stock.unitCostUsdMinor,
        currency: "USD",
        fxRateToPyg: USD_FX,
        unitLandedCostPyg: WATCH.stock.unitLandedCostPyg,
      },
    ],
  });

  // --- Inventario por la API ----------------------------------------------
  // Unidades serializadas del Casio (RN-SER-04: la variante la deriva el lote).
  const casioLotId = lots["DEV-CASIO-01"];
  const knownSerials = (
    await listAll(client, "inventory.serial.list", { variantId: variantIds[WATCH.sku] })
  ).map((unit) => unit.serialNumber);
  for (const serialNumber of WATCH.serials) {
    if (knownSerials.includes(serialNumber)) continue;
    await client.mutation("inventory.serial.create", {
      lotId: casioLotId,
      serialNumber,
      warrantyUntil: "2027-12-31",
    });
    log(`unidad serializada creada: ${serialNumber}`);
  }

  // Abrir un frasco de Layton: nace el lote de granel en ml que hereda el costo
  // (RN-LOT-02, ADR-009) — así el fraccionamiento tiene de dónde sacar.
  const laytonVariantId = variantIds["LAYTON-125"];
  const laytonLotId = lots["DEV-LAYTON-01"];
  const stock = await client.query("inventory.stock.available", { variantId: laytonVariantId });
  // Si ya se abrió un frasco en una corrida anterior, el saldo sellado es menor al recibido.
  if (stock.onHand >= PERFUMES[0].stock.qty) {
    await client.mutation("inventory.lot.open", { lotId: laytonLotId });
    log("frasco de Layton abierto: lote de granel creado");
  }

  return { productIds, variantIds, lots };
}
