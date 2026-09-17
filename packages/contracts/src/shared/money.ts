// Dinero en la frontera — string, nunca number (docs/api-conventions.md §3,
// .claude/rules/contracts.md). Un bigint no sobrevive JSON.stringify y un
// number grande pierde precisión; moneySchema exige el string ya en el
// borde de entrada/salida de la API, antes de que un number se cuele en un
// handler. Es el mismo par de campos que produce Money.toJSON() en
// packages/domain/src/shared/money.ts — este esquema valida esa forma, no
// la reimplementa.
import { z } from "zod";

export const CURRENCIES = ["PYG", "USD", "BRL", "ARS"] as const;

export const currencySchema = z.enum(CURRENCIES);

export type ContractCurrency = z.infer<typeof currencySchema>;

export const moneySchema = z
  .object({
    minor: z.string().regex(/^-?\d+$/, "minor debe ser un entero en formato string"),
    currency: currencySchema,
  })
  .strict();

export type MoneyDto = z.infer<typeof moneySchema>;
