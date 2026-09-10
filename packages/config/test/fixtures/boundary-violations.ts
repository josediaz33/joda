// Fixture de regresión para test/boundaries.test.ts.
//
// Las ocho líneas de abajo son exactamente lo que packages/domain tiene
// prohibido (CLAUDE.md § Código, .claude/rules/domain.md): tres imports
// (un cliente de base, un framework, un módulo nativo de Node) y cinco usos
// de globals/propiedades que no son imports (Date, crypto, fetch,
// process.env, Math.random).
//
// Este archivo nunca se ejecuta ni se compila: el test lo lintea con una
// ruta virtual bajo packages/domain/src/ (ver boundaries.test.ts) para
// activar la restricción sin que el código exista de verdad ahí. Por eso
// está excluido de tsconfig.json — si tsc lo tocara, fallaría con "no se
// encuentra el módulo" para @prisma/client y react, que no están instalados
// a propósito.
import { PrismaClient } from "@prisma/client";
import React from "react";
import fs from "node:fs";

export function violatePurity() {
  const client = new PrismaClient();
  const el = React.createElement("div");
  const contents = fs.readFileSync("/tmp/x");

  const now = Date.now();
  const envVar = process.env.SOMETHING;
  const rnd = Math.random();
  const id = crypto.randomUUID();
  void fetch("https://example.com");

  return { client, el, contents, now, envVar, rnd, id };
}
