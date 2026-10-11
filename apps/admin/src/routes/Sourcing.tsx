// WP-C16: vista previa de escenarios de sourcing (RF-SRC-01…03), calculada
// con packages/domain directamente en el cliente (frontend-spec.md §8.7: "la
// tabla recalcula el costo puesto y el margen proyectado en vivo, antes de
// confirmar" — el mismo criterio que la recepción con prorrateo).
//
// Sin persistencia todavía: apps/api no tiene el módulo de sourcing
// (WP-C16b, docs/backlog.md). "Guardar" y "Convertir en orden de compra"
// quedan deshabilitados — no hay contra qué llamarlos — y el cálculo vive
// enteramente en este componente, sin round-trip al servidor.
import { useId, useMemo, useState } from "react";
import {
  createSourcingScenarioLineInput,
  sourcingAssumptionsSchema,
  type CreateSourcingScenarioLineInput,
  type SourcingAssumptions,
} from "@joda/contracts";
import {
  Money,
  Percentage,
  Quantity,
  compareScenarioLines,
  projectScenarioLines,
  type FreightError,
  type ScenarioLineInput,
  type ScenarioLineProjection,
} from "@joda/domain";
import { Button } from "@joda/ui/primitives/button";
import { formatPyg } from "@joda/ui/format/money";
import { formatPercent } from "@joda/ui/format/percent";
import { Can } from "../Can";

const inputClass =
  "w-full rounded-control border border-border-strong bg-surface px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-focus aria-invalid:border-error";
// Sin PYG: procurement/landedCost.ts::convertToPyg (WP-A05, reusado por
// projectScenarioLines) lanza InvalidLandedCostInputError si un componente
// ya viene en PYG — no hay nada que convertir. RF-SRC-01 asume compra en
// moneda extranjera (fx, flete, aranceles son conceptos de importación);
// una compra local no necesita un escenario de sourcing. Hallazgo de la
// revisión cruzada (una línea en PYG disparaba esa excepción cruda).
const FOREIGN_CURRENCIES = ["USD", "BRL", "ARS"] as const;

type DraftLine = {
  readonly key: string;
  variantId: string;
  variantLabel: string;
  uom: "unit" | "ml";
  qty: string;
  unitPriceMinor: string;
  currency: CreateSourcingScenarioLineInput["currency"];
  fxAssumed: string;
  vatRate: CreateSourcingScenarioLineInput["vatRate"];
  projectedPricePyg: string;
  manualFreightMinor: string;
  volume: string;
};

// Los campos de texto (type="text", no type="number") arrancan en "" y NO
// en "0": un <input type="number"> sanitiza los ceros a la izquierda al
// escribir (0 + "10" tipeado da "10"), pero type="text" no — con "0" como
// valor inicial, hacer click al final y escribir "3500000" sin borrar da
// "03500000", que la validación nueva rechaza. Regresión real de la
// revisión cruzada anterior, con test (Sourcing.test.tsx).
function newLine(): DraftLine {
  return {
    key: crypto.randomUUID(),
    variantId: "",
    variantLabel: "",
    uom: "unit",
    qty: "1",
    unitPriceMinor: "",
    currency: "USD",
    fxAssumed: "7300",
    vatRate: "iva_10",
    projectedPricePyg: "",
    manualFreightMinor: "",
    volume: "0",
  };
}

type Assumptions = {
  freightTotalMinor: string;
  freightCurrency: SourcingAssumptions["freightCurrency"];
  freightMethod: SourcingAssumptions["freightMethod"];
  tariffRatePct: string;
};

function defaultAssumptions(): Assumptions {
  return {
    freightTotalMinor: "",
    freightCurrency: "USD",
    freightMethod: "by_value",
    tariffRatePct: "0",
  };
}

type Computation =
  | { readonly status: "empty" }
  | { readonly status: "invalid"; readonly errors: readonly string[] }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ok";
      readonly projections: readonly ScenarioLineProjection[];
      readonly bestKeyByVariant: ReadonlyMap<string, string>;
    };

// Record<FreightError["code"], string> en vez de Record<string, string>: si
// procurement/freight.ts (WP-A05) agrega un código de error nuevo, TypeScript
// obliga a mapearlo acá en vez de caer en silencio al mensaje genérico.
const FREIGHT_ERROR_MESSAGES: Record<FreightError["code"], string> = {
  EMPTY_LINES: "Agregá al menos una línea para prorratear el flete.",
  ZERO_TOTAL_WEIGHT: "Ninguna línea tiene valor, cantidad o volumen para repartir el flete.",
  MISSING_VOLUME: "El método 'por volumen' necesita el volumen de cada línea.",
  MISSING_MANUAL_AMOUNT: "El método 'manual' necesita el flete de cada línea.",
  LINE_CURRENCY_MISMATCH: "Todas las líneas tienen que compartir moneda para repartir por valor.",
  LINE_UOM_MISMATCH:
    "Todas las líneas tienen que compartir unidad (unidad/ml) para repartir por cantidad.",
  MANUAL_SUM_MISMATCH: "La suma del flete manual de las líneas no coincide con el flete total.",
};

function toQuantity(line: DraftLine): Quantity {
  const value = Number(line.qty);
  return line.uom === "ml" ? Quantity.ml(value) : Quantity.units(value);
}

function toScenarioLineInput(line: DraftLine): ScenarioLineInput {
  return {
    id: line.key,
    variantId: line.variantId,
    variantLabel: line.variantLabel || undefined,
    qty: toQuantity(line),
    unitPrice: Money.of(BigInt(line.unitPriceMinor), line.currency),
    fxRateToPyg: Number(line.fxAssumed),
    projectedPricePyg: Money.pyg(BigInt(line.projectedPricePyg)),
    vatRate: line.vatRate,
    volume: Number(line.volume) || undefined,
    manualFreightAmount: Money.of(BigInt(line.manualFreightMinor || "0"), line.currency),
  };
}

/**
 * Validaciones que `createSourcingScenarioLineInput` no puede expresar —
 * cruzan varias líneas, o dependen del `uom` elegido en la UI (que no viaja
 * en el contrato: `sourcing_scenario_lines` no tiene esa columna, RN-SRC-01).
 * Sin esto, una entrada que el contrato acepta llega al dominio y éste la
 * rechaza con una EXCEPCIÓN (precio proyectado positivo, cantidad entera
 * para 'unit', moneda extranjera) en vez de un mensaje de validación: un
 * precio en 0 —el valor por defecto de una línea nueva— no debería
 * mostrarle al usuario el mensaje interno de `InvalidSourcingInputError`.
 */
function validateCrossFieldRules(lines: readonly DraftLine[], assumptions: Assumptions): string[] {
  const errors: string[] = [];

  lines.forEach((line, index) => {
    if (!/^[1-9]\d*$/.test(line.projectedPricePyg)) {
      errors.push(`Línea ${index + 1}: el precio de venta proyectado tiene que ser mayor a cero.`);
    }
    if (line.uom === "unit" && line.qty.includes(".")) {
      errors.push(`Línea ${index + 1}: una cantidad en unidades tiene que ser un entero.`);
    }
  });

  const currencies = new Set([assumptions.freightCurrency, ...lines.map((line) => line.currency)]);
  if (currencies.size > 1) {
    errors.push(
      "El flete y todas las líneas tienen que estar en la misma moneda — procurement/landedCost.ts no convierte entre monedas extranjeras.",
    );
  }

  return errors;
}

function compute(
  lines: readonly DraftLine[],
  assumptions: Assumptions,
  marginThresholdPctRaw: string,
): Computation {
  if (lines.every((line) => line.variantId.trim() === "")) {
    return { status: "empty" };
  }

  const errors: string[] = [];

  const tariffRate = Number(assumptions.tariffRatePct) / 100;
  const assumptionsResult = sourcingAssumptionsSchema.safeParse({
    freightTotalMinor: assumptions.freightTotalMinor,
    freightCurrency: assumptions.freightCurrency,
    freightMethod: assumptions.freightMethod,
    tariffRate,
  });
  if (!assumptionsResult.success) errors.push("Los supuestos del escenario no son válidos.");

  const thresholdNum = Number(marginThresholdPctRaw);
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum >= 0 && thresholdNum <= 100;
  if (!thresholdValid)
    errors.push("El umbral de margen tiene que ser un porcentaje entre 0 y 100.");

  const lineResults = lines.map((line) =>
    createSourcingScenarioLineInput.safeParse({
      variantId: line.variantId,
      variantLabel: line.variantLabel || undefined,
      qty: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      currency: line.currency,
      fxAssumed: line.fxAssumed,
      vatRate: line.vatRate,
      projectedPricePyg: line.projectedPricePyg,
    }),
  );
  lineResults.forEach((result, index) => {
    if (!result.success) errors.push(`Línea ${index + 1}: datos incompletos o inválidos.`);
  });
  errors.push(...validateCrossFieldRules(lines, assumptions));

  if (errors.length > 0 || !assumptionsResult.success) return { status: "invalid", errors };

  try {
    const projected = projectScenarioLines({
      lines: lines.map(toScenarioLineInput),
      assumptions: {
        freightTotal: Money.of(BigInt(assumptions.freightTotalMinor), assumptions.freightCurrency),
        freightMethod: assumptions.freightMethod,
        tariffRate: Percentage.of(tariffRate),
      },
      marginThresholdPct: Percentage.of(thresholdNum / 100),
    });

    if (!projected.ok) {
      return {
        status: "error",
        message:
          FREIGHT_ERROR_MESSAGES[projected.error.reason.code] ??
          "No se pudo prorratear el flete entre las líneas.",
      };
    }

    // Solo variantes con MÁS DE UNA línea tienen algo que comparar — con
    // una sola, "mejor opción" no informa nada (hallazgo de la revisión
    // cruzada, §6).
    const groups = compareScenarioLines(projected.value).filter(
      (group) => group.projections.length > 1,
    );
    const bestKeyByVariant = new Map(groups.map((group) => [group.variantId, group.bestLineId]));

    return { status: "ok", projections: projected.value, bestKeyByVariant };
  } catch (cause) {
    return {
      status: "error",
      message: cause instanceof Error ? cause.message : "No se pudo calcular el escenario.",
    };
  }
}

export default function Sourcing() {
  const [name, setName] = useState("");
  const [assumptions, setAssumptions] = useState<Assumptions>(defaultAssumptions);
  const [marginThresholdPct, setMarginThresholdPct] = useState("25");
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const nameId = useId();
  const freightTotalId = useId();
  const freightMethodId = useId();
  const tariffRateId = useId();
  const marginThresholdId = useId();

  const computation = useMemo(
    () => compute(lines, assumptions, marginThresholdPct),
    [lines, assumptions, marginThresholdPct],
  );

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="font-display text-heading-lg">Escenarios de compra</h1>
      <p className="mt-2 max-w-3xl text-text-secondary">
        Simulá costo puesto y margen antes de comprar — no afecta inventario, caja ni cuentas por
        pagar (RF-SRC-04). Esta vista previa calcula en el navegador; todavía no hay dónde guardar
        el escenario ni convertirlo en orden de compra (WP-C16b).
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={nameId} className="mb-1 block text-sm font-semibold">
            Nombre del escenario
          </label>
          <input
            id={nameId}
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Proveedor A vs. B"
          />
        </div>
        <div>
          <label htmlFor={freightTotalId} className="mb-1 block text-sm font-semibold">
            Flete total
          </label>
          <div className="flex gap-2">
            <input
              id={freightTotalId}
              type="text"
              inputMode="numeric"
              className={inputClass}
              value={assumptions.freightTotalMinor}
              onChange={(event) =>
                setAssumptions((current) => ({
                  ...current,
                  freightTotalMinor: event.target.value.replace(/\D/g, ""),
                }))
              }
            />
            <select
              className={inputClass}
              aria-label="Moneda del flete"
              value={assumptions.freightCurrency}
              onChange={(event) =>
                setAssumptions((current) => ({
                  ...current,
                  freightCurrency: event.target.value as Assumptions["freightCurrency"],
                }))
              }
            >
              {FOREIGN_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor={freightMethodId} className="mb-1 block text-sm font-semibold">
            Método de prorrateo
          </label>
          <select
            id={freightMethodId}
            className={inputClass}
            value={assumptions.freightMethod}
            onChange={(event) =>
              setAssumptions((current) => ({
                ...current,
                freightMethod: event.target.value as Assumptions["freightMethod"],
              }))
            }
          >
            <option value="by_value">Por valor</option>
            <option value="by_unit">Por cantidad</option>
            <option value="by_volume">Por volumen</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <div>
          <label htmlFor={tariffRateId} className="mb-1 block text-sm font-semibold">
            Arancel (%, ad valorem)
          </label>
          <input
            id={tariffRateId}
            type="number"
            min="0"
            step="any"
            className={inputClass}
            value={assumptions.tariffRatePct}
            onChange={(event) =>
              setAssumptions((current) => ({ ...current, tariffRatePct: event.target.value }))
            }
          />
        </div>
        <div>
          <label htmlFor={marginThresholdId} className="mb-1 block text-sm font-semibold">
            Umbral de margen (%)
          </label>
          <input
            id={marginThresholdId}
            type="number"
            min="0"
            max="100"
            step="any"
            className={inputClass}
            value={marginThresholdPct}
            onChange={(event) => setMarginThresholdPct(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[72rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-secondary">
              <th className="py-2 pr-2">Variante</th>
              <th className="py-2 pr-2">Etiqueta</th>
              <th className="py-2 pr-2">Cantidad</th>
              <th className="py-2 pr-2">Precio proveedor</th>
              <th className="py-2 pr-2">FX asumido</th>
              {assumptions.freightMethod === "manual" && <th className="py-2 pr-2">Flete</th>}
              {assumptions.freightMethod === "by_volume" && <th className="py-2 pr-2">Volumen</th>}
              <th className="py-2 pr-2">IVA</th>
              <th className="py-2 pr-2">Precio de venta (Gs.)</th>
              <th className="py-2 pr-2">Costo puesto/u.</th>
              <th className="py-2 pr-2">Ganancia/u.</th>
              <th className="py-2 pr-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const projection =
                computation.status === "ok"
                  ? computation.projections.find((item) => item.lineId === line.key)
                  : undefined;
              const isBest =
                computation.status === "ok" &&
                computation.bestKeyByVariant.get(line.variantId) === line.key;
              return (
                <tr key={line.key} className="border-b border-border-subtle">
                  <td className="py-1.5 pr-2">
                    <input
                      className={inputClass}
                      value={line.variantId}
                      onChange={(event) => updateLine(line.key, { variantId: event.target.value })}
                      aria-label="Id de variante"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      className={`${inputClass} w-16`}
                      maxLength={1}
                      value={line.variantLabel}
                      onChange={(event) =>
                        updateLine(line.key, { variantLabel: event.target.value })
                      }
                      aria-label="Etiqueta (A/B)"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex gap-1">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className={inputClass}
                        value={line.qty}
                        onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                        aria-label="Cantidad"
                      />
                      <select
                        className={inputClass}
                        value={line.uom}
                        onChange={(event) =>
                          updateLine(line.key, { uom: event.target.value as DraftLine["uom"] })
                        }
                        aria-label="Unidad de medida"
                      >
                        <option value="unit">unidad</option>
                        <option value="ml">ml</option>
                      </select>
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex gap-1">
                      <input
                        type="text"
                        inputMode="numeric"
                        className={inputClass}
                        value={line.unitPriceMinor}
                        onChange={(event) =>
                          updateLine(line.key, {
                            unitPriceMinor: event.target.value.replace(/\D/g, ""),
                          })
                        }
                        aria-label="Precio del proveedor (centavos)"
                      />
                      <select
                        className={inputClass}
                        value={line.currency}
                        onChange={(event) =>
                          updateLine(line.key, {
                            currency: event.target.value as DraftLine["currency"],
                          })
                        }
                        aria-label="Moneda"
                      >
                        {FOREIGN_CURRENCIES.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      className={inputClass}
                      value={line.fxAssumed}
                      onChange={(event) => updateLine(line.key, { fxAssumed: event.target.value })}
                      aria-label="Tipo de cambio asumido"
                    />
                  </td>
                  {assumptions.freightMethod === "manual" && (
                    <td className="py-1.5 pr-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        className={inputClass}
                        value={line.manualFreightMinor}
                        onChange={(event) =>
                          updateLine(line.key, {
                            manualFreightMinor: event.target.value.replace(/\D/g, ""),
                          })
                        }
                        aria-label="Flete manual (centavos)"
                      />
                    </td>
                  )}
                  {assumptions.freightMethod === "by_volume" && (
                    <td className="py-1.5 pr-2">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className={inputClass}
                        value={line.volume}
                        onChange={(event) => updateLine(line.key, { volume: event.target.value })}
                        aria-label="Volumen"
                      />
                    </td>
                  )}
                  <td className="py-1.5 pr-2">
                    <select
                      className={inputClass}
                      value={line.vatRate}
                      onChange={(event) =>
                        updateLine(line.key, {
                          vatRate: event.target.value as DraftLine["vatRate"],
                        })
                      }
                      aria-label="IVA"
                    >
                      <option value="iva_10">10%</option>
                      <option value="iva_5">5%</option>
                      <option value="exenta">Exenta</option>
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      className={inputClass}
                      value={line.projectedPricePyg}
                      onChange={(event) =>
                        updateLine(line.key, {
                          projectedPricePyg: event.target.value.replace(/\D/g, ""),
                        })
                      }
                      aria-label="Precio de venta proyectado"
                    />
                  </td>
                  <td className="py-1.5 pr-2 font-medium">
                    {projection ? formatPyg(projection.unitLandedPyg.minor.toString()) : "—"}
                  </td>
                  <td
                    className={`py-1.5 pr-2 font-medium ${
                      projection?.belowThreshold ? "text-error" : ""
                    }`}
                  >
                    {projection ? (
                      <span>
                        {/* Ganancia absoluta: criterio de "mejor opción" (RN-SRC-04, decisión
                            de José). El margen % queda como dato auxiliar, entre paréntesis —
                            no decide nada. */}
                        <span>{formatPyg(projection.profitPyg.minor.toString())}</span>
                        {" ("}
                        <span className="text-xs text-text-secondary">
                          {formatPercent(projection.marginPct)}
                        </span>
                        {")"}
                        {projection.belowThreshold && (
                          <span aria-label="Por debajo del umbral"> ⚠</span>
                        )}
                        {isBest && (
                          <span className="ml-1 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                            Mejor opción
                          </span>
                        )}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={lines.length === 1}
                      onClick={() =>
                        setLines((current) => current.filter((l) => l.key !== line.key))
                      }
                    >
                      Quitar
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => setLines((current) => [...current, newLine()])}
        >
          Agregar línea
        </Button>
      </div>

      {computation.status === "invalid" && (
        <ul className="mt-4 space-y-1" role="alert">
          {computation.errors.map((message) => (
            <li key={message} className="text-sm text-error">
              {message}
            </li>
          ))}
        </ul>
      )}
      {computation.status === "error" && (
        <p role="alert" className="mt-4 text-sm text-error">
          {computation.message}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Can perform="market.sourcing:write">
          <Button type="button" disabled title="Disponible cuando WP-C16b conecte la API.">
            Guardar escenario
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled
            title="Disponible cuando WP-C16b conecte la API."
          >
            Convertir en orden de compra
          </Button>
        </Can>
      </div>
    </main>
  );
}
