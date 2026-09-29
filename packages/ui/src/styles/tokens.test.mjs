import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { URL } from "node:url";

const stylesheet = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const darkStart = stylesheet.indexOf('[data-theme="dark"] {');
assert.ok(darkStart >= 0, "Falta el selector oscuro aplicable por sección");
const light = declarations(stylesheet.slice(0, darkStart));
const dark = { ...light, ...declarations(stylesheet.slice(darkStart)) };

function declarations(source) {
  return Object.fromEntries(
    [...source.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function color(name, tokens) {
  const value = tokens[`--color-${name}`];
  assert.ok(value, `Falta --color-${name}`);

  if (/^#[\da-f]{6}$/i.test(value)) {
    return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  }

  const alias = value.match(/^var\((--color-[a-z-]+)\)$/);
  if (alias) {
    return color(alias[1].slice("--color-".length), tokens);
  }

  const mix = value.match(
    /^color-mix\(\s*in srgb,\s*var\((--color-[a-z-]+)\)\s+(\d+)%,\s*var\((--color-[a-z-]+)\)\s*\)$/s,
  );
  assert.ok(mix, `Valor de color no reconocido para ${name}: ${value}`);
  const first = color(mix[1].slice("--color-".length), tokens);
  const second = color(mix[3].slice("--color-".length), tokens);
  const fraction = Number(mix[2]) / 100;
  return first.map((channel, index) =>
    Math.round(channel * fraction + second[index] * (1 - fraction)),
  );
}

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertContrast(foreground, background, tokens, mode, minimum) {
  const ratio = contrast(color(foreground, tokens), color(background, tokens));
  assert.ok(
    ratio >= minimum,
    `${mode}: ${foreground} sobre ${background} da ${ratio.toFixed(2)}:1 (mínimo ${minimum}:1)`,
  );
}

function assertThemeAa(tokens, mode) {
  const textRoles = [
    "text",
    "text-secondary",
    "accent",
    "error",
    "success",
    "warning",
    "info",
    "stock-available",
    "stock-low",
    "stock-sold-out",
    "stock-made-to-order",
  ];
  for (const foreground of textRoles) {
    assertContrast(foreground, "surface", tokens, mode, 4.5);
    assertContrast(foreground, "surface-elevated", tokens, mode, 4.5);
  }
  assertContrast("accent-foreground", "accent", tokens, mode, 4.5);
}

function assertThemeNonTextAa(tokens, mode) {
  for (const foreground of ["border-strong", "focus"]) {
    assertContrast(foreground, "surface", tokens, mode, 3);
    assertContrast(foreground, "surface-elevated", tokens, mode, 3);
  }
}

describe("RNF-USA-04 · frontend-spec.md §7 · contraste AA", () => {
  test("los roles semánticos mantienen 4,5:1 en ambas superficies claras", () => {
    assertThemeAa(light, "claro");
  });

  test("los roles semánticos mantienen 4,5:1 en ambas superficies oscuras", () => {
    assertThemeAa(dark, "oscuro");
  });

  test("contornos de controles y foco mantienen 3:1 en ambas superficies y modos", () => {
    assertThemeNonTextAa(light, "claro");
    assertThemeNonTextAa(dark, "oscuro");
  });
});

describe("WP-E02 · backlog · shadcn usa roles existentes", () => {
  test("los siete roles obligatorios son alias y no otra paleta", () => {
    assert.equal(light["--color-background"], "var(--color-surface)");
    assert.equal(light["--color-foreground"], "var(--color-text)");
    assert.equal(light["--color-primary"], "var(--color-accent)");
    assert.equal(light["--color-destructive"], "var(--color-error)");
    assert.equal(light["--color-muted"], "var(--color-surface-elevated)");
    assert.equal(light["--color-ring"], "var(--color-focus)");
    assert.equal(light["--color-input"], "var(--color-border-strong)");
  });

  test("texto, foco y controles mantienen contraste en ambos temas", () => {
    assertContrast("foreground", "background", light, "claro", 4.5);
    assertContrast("foreground", "background", dark, "oscuro", 4.5);
    assertContrast("muted-foreground", "muted", light, "claro", 4.5);
    assertContrast("muted-foreground", "muted", dark, "oscuro", 4.5);
    assertContrast("primary-foreground", "primary", light, "claro", 4.5);
    assertContrast("primary-foreground", "primary", dark, "oscuro", 4.5);
    assertContrast("ring", "background", light, "claro", 3);
    assertContrast("ring", "background", dark, "oscuro", 3);
    assertContrast("input", "background", light, "claro", 3);
    assertContrast("input", "background", dark, "oscuro", 3);
  });
});
