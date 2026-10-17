import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILES, generateContracts, INVENTORY_FILE } from "../../../scripts/gen-contracts";

const root = join(import.meta.dir, "..", "..", "..");
const inventory = readFileSync(join(root, INVENTORY_FILE), "utf8");

describe("env inventory", () => {
  test("generated src/contracts files equal the output of gen-contracts for env-inventory.yaml", () => {
    const generated = generateContracts(inventory);
    expect(readFileSync(join(root, CONTRACT_FILES.studio), "utf8")).toBe(generated.studio);
    expect(readFileSync(join(root, CONTRACT_FILES.platform), "utf8")).toBe(generated.platform);
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
