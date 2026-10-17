// Fails unless every pure module under src/ has 100% line coverage in the lcov report.
// src/adapters, src/steps and src/cli only wire pure modules to the host and are
// covered by the integration and end-to-end tests instead.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const EXEMPT_PREFIXES = ["src/adapters/", "src/steps/", "src/cli/"] as const;

export interface FileLines {
  found: number;
  hit: number;
}

export function parseLcov(lcov: string, root: string): Map<string, FileLines> {
  const files = new Map<string, FileLines>();
  let current: string | undefined;
  let found = 0;
  let hit = 0;
  for (const raw of lcov.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = line.slice(3);
      current = path.startsWith("/") ? relative(root, path) : path;
      found = 0;
      hit = 0;
    } else if (line.startsWith("DA:")) {
      const count = Number(line.slice(3).split(",")[1]);
      if (Number.isNaN(count)) throw new Error(`malformed lcov line: ${line}`);
      found += 1;
      if (count > 0) hit += 1;
    } else if (line === "end_of_record") {
      if (current === undefined) throw new Error("lcov record without SF line");
      files.set(current, { found, hit });
      current = undefined;
    }
  }
  return files;
}

export function isGated(path: string): boolean {
  return path.startsWith("src/") && !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function findCoverageFailures(sources: readonly string[], report: Map<string, FileLines>): string[] {
  const failures: string[] = [];
  for (const source of sources.filter(isGated).sort()) {
    const lines = report.get(source);
    if (lines === undefined) {
      failures.push(`${source}: not loaded by any unit test`);
    } else if (lines.hit < lines.found) {
      const percent = ((lines.hit / lines.found) * 100).toFixed(2);
      failures.push(`${source}: ${percent}% lines (${lines.hit}/${lines.found})`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const lcovPath = process.argv[2];
  if (lcovPath === undefined) {
    console.error("usage: bun scripts/check-coverage.ts <lcov.info>");
    process.exit(2);
  }
  const report = parseLcov(readFileSync(lcovPath, "utf8"), root);
  const sources = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })];
  const failures = findCoverageFailures(sources, report);
  if (failures.length > 0) {
    console.error(`Line coverage below 100% for pure modules:\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Line coverage 100% for ${sources.filter(isGated).length} pure module(s) under src/.`);
}
