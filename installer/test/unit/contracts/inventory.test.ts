import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILES, generateContracts, INVENTORY_FILE } from "../../../scripts/gen-contracts";
import { PLATFORM_ENV, PLATFORM_MIGRATE_ENV, type EnvProducer } from "../../../src/contracts/platform";

const root = join(import.meta.dir, "..", "..", "..");
const inventory = readFileSync(join(root, INVENTORY_FILE), "utf8");
const PLATFORM_RUNTIME_DOC = join(root, "..", "docs", "deploy", "platform-runtime.md");

// Platform's runtime page writes producer config as "installer config": the installer copies it from its configuration.
const DOCUMENTED_PRODUCER: Record<EnvProducer, string> = {
  installer: "installer",
  config: "installer config",
  default: "default",
  operator: "operator",
};

/** The Producer column of the environment inventory table in docs/deploy/platform-runtime.md, by variable. */
function documentedProducers(): Map<string, string> {
  const lines = readFileSync(PLATFORM_RUNTIME_DOC, "utf8").split("\n");
  const start = lines.indexOf("## Environment inventory");
  if (start === -1) throw new Error("docs/deploy/platform-runtime.md has no section ## Environment inventory");
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const producers = new Map<string, string>();
  for (const row of lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.startsWith("| `"))) {
    const cells = row.split("|").map((cell) => cell.trim());
    for (const name of (cells[1] ?? "").matchAll(/`([A-Z0-9_]+)`/g)) producers.set(name[1] ?? "", cells[4] ?? "");
  }
  return producers;
}

describe("env inventory", () => {
  test("generated src/contracts files equal the output of gen-contracts for env-inventory.yaml", () => {
    const generated = generateContracts(inventory);
    expect(readFileSync(join(root, CONTRACT_FILES.studio), "utf8")).toBe(generated.studio);
    expect(readFileSync(join(root, CONTRACT_FILES.platform), "utf8")).toBe(generated.platform);
  });

  test("Platform's runtime page names the producer that env-inventory.yaml gives each Platform variable it lists", () => {
    const documented = documentedProducers();
    const listed = Object.entries({ ...PLATFORM_ENV, ...PLATFORM_MIGRATE_ENV }).filter(([name]) => documented.has(name));
    expect(listed.length).toBeGreaterThan(0);
    const disagreements = listed
      .filter(([name, descriptor]) => documented.get(name) !== DOCUMENTED_PRODUCER[descriptor.producer])
      .map(([name, descriptor]) => `${name}: ${documented.get(name)}, not ${DOCUMENTED_PRODUCER[descriptor.producer]}`);
    expect(disagreements).toEqual([]);
  });

  test("refuses a variable listed twice for the same app, naming it and the app", () => {
    const twice = `variables:
  - { name: PORT, apps: [studio], required: optional, secret: false, producer: installer, value: "3000" }
  - { name: PORT, apps: [studio, platform], required: optional, secret: false, producer: installer, value: "3001" }
studioForbidden: []
`;
    expect(() => generateContracts(twice)).toThrow("PORT is listed twice for studio");
  });

  test("refuses a forbidden Studio variable that the inventory also writes for Studio", () => {
    const clash = `variables:
  - { name: ADMIN_PASSWORD, apps: [studio], required: always, secret: true, producer: installer, value: x }
studioForbidden: [ADMIN_PASSWORD]
`;
    expect(() => generateContracts(clash)).toThrow("ADMIN_PASSWORD is both a Studio variable and forbidden");
  });

  test("refuses a written variable without a value and a never-written one with a write condition", () => {
    const noValue = `variables:
  - { name: PORT, apps: [studio], required: optional, secret: false, producer: installer }
studioForbidden: []
`;
    expect(() => generateContracts(noValue)).toThrow("PORT: producer installer needs a value");
    const defaultWhen = `variables:
  - { name: PORT, apps: [studio], required: optional, secret: false, producer: default, value: "3000", when: httpsProxy }
studioForbidden: []
`;
    expect(() => generateContracts(defaultWhen)).toThrow("PORT: producer default is never written, so it takes no when");
  });

  test("refuses an unknown field with its path", () => {
    const unknown = `variables:
  - { name: PORT, apps: [studio], required: optional, secret: false, producer: installer, value: "3000", note: x }
studioForbidden: []
`;
    expect(() => generateContracts(unknown)).toThrow("variables[0]");
  });
});
