import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

// No hay una RN-XXX que citar: es la convención de paginación de
// docs/api-conventions.md §6 ("el cursor es opaco... el cliente no lo
// interpreta"), no una regla de negocio del dominio.
describe("encodeCursor/decodeCursor — cursor opaco (docs/api-conventions.md §6)", () => {
  it("decodeCursor recupera el mismo id que encodeCursor codificó", () => {
    const id = "0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a";

    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it("el cursor codificado no es el uuid en texto plano — es opaco", () => {
    const id = "0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a";

    expect(encodeCursor(id)).not.toBe(id);
    expect(encodeCursor(id)).not.toContain(id);
  });

  it("un cursor que no decodifica a un uuid válido es null, no un id a medias", () => {
    expect(decodeCursor("no-es-base64-valido-de-un-uuid")).toBeNull();
  });

  it("un cursor vacío es null", () => {
    expect(decodeCursor("")).toBeNull();
  });
});
