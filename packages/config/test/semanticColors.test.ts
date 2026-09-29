import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const eslint = new ESLint({ cwd: repoRoot });
const filePath = path.join(repoRoot, "apps/admin/src/Example.tsx");

describe("WP-E02 · backlog · clases de color semántico", () => {
  it("rechaza un primitivo joda-* dentro de cn()", async () => {
    const results = await eslint.lintText('void <div className={cn("hover:bg-joda-ink")} />;', {
      filePath,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  }, 30000);

  it("rechaza una clase primitiva guardada antes de className", async () => {
    const results = await eslint.lintText(
      'const colorClass = "text-joda-gold"; void <span className={colorClass} />;',
      { filePath },
    );

    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  });

  it("rechaza className literal", async () => {
    const results = await eslint.lintText('void <span className="bg-joda-ink" />;', {
      filePath,
    });

    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  });

  it("rechaza divide-joda-ink", async () => {
    const results = await eslint.lintText('void <div className="divide-joda-ink" />;', {
      filePath,
    });

    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  });

  it("rechaza placeholder-joda-stone", async () => {
    const results = await eslint.lintText('void <input className="placeholder-joda-stone" />;', {
      filePath,
    });

    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  });

  it("rechaza colores joda dentro de valores arbitrarios", async () => {
    const results = await eslint.lintText('void <div className="bg-[var(--color-joda-ink)]" />;', {
      filePath,
    });

    expect(results[0]?.messages.map(({ ruleId }) => ruleId)).toContain("joda-ui/semantic-colors");
  });

  it("acepta roles semánticos", async () => {
    const results = await eslint.lintText(
      'void <div className="bg-background text-foreground" />;',
      { filePath },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.messages).toEqual([]);
  });
});
