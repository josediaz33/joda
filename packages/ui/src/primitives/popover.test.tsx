// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./popover";

describe("RNF-USA-04 · frontend-spec.md §7 · nombre accesible de Popover", () => {
  test("el diálogo expone su nombre y un encabezado semántico", () => {
    render(
      <Popover open>
        <PopoverTrigger>Mostrar opciones</PopoverTrigger>
        <PopoverContent aria-label="Opciones del producto">
          <PopoverTitle>Opciones del producto</PopoverTitle>
        </PopoverContent>
      </Popover>,
    );

    expect(screen.getByRole("dialog", { name: "Opciones del producto" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Opciones del producto" })).toBeTruthy();
  });

  test("rechaza un nombre accesible vacío", () => {
    expect(() =>
      render(
        <Popover open>
          <PopoverTrigger>Mostrar opciones</PopoverTrigger>
          <PopoverContent aria-label=" ">Contenido</PopoverContent>
        </Popover>,
      ),
    ).toThrow(/aria-label no vacío/);
  });
});
