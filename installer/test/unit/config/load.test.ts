import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOverrides, loadConfig, parseSet, readConfigDocument } from "../../../src/config/load";
import { ConfigError } from "../../../src/config/schema";

const dir = mkdtempSync(join(tmpdir(), "libredb-installer-load-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MINIMAL = `apiVersion: install.libredb.org/v1
kind: LibreDBInstallation
metadata:
  name: acme
mode: docker
endpoints:
  hosts:
    platform: platform.corp
    studio: studio.corp
    auth: auth.corp
platform:
  organizationName: Acme
  licenseFile: /etc/libredb/platform.license
`;

let counter = 0;
function file(content: string): string {
  counter += 1;
  const path = join(dir, `config-${counter}.yaml`);
  writeFileSync(path, content);
  return path;
}

function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  test("a --set override wins over the file and parses false as a boolean", () => {
    const path = file(`${MINIMAL}docker:\n  systemdUnit: true\n`);
    const fromFile = loadConfig({ file: path });
    if (fromFile.mode !== "docker") throw new Error("expected docker mode");
    expect(fromFile.docker.systemdUnit).toBe(true);
    const config = loadConfig({ file: path, sets: ["docker.systemdUnit=false"] });
    if (config.mode !== "docker") throw new Error("expected docker mode");
    expect(config.docker.systemdUnit).toBe(false);
  });

  test("later overrides win over earlier ones and create missing mappings", () => {
    const config = loadConfig({
      file: file(MINIMAL),
      sets: ["keycloak.adminPort=1", "keycloak.adminPort=28080", "images.registry=harbor.corp/libredb"],
    });
    expect(config.keycloak.adminPort).toBe(28080);
    expect(config.images).toEqual({ registry: "harbor.corp/libredb" });
  });

  test("an unreadable file is a ConfigError naming the file", () => {
    const missing = join(dir, "missing.yaml");
    expect(configError(() => loadConfig({ file: missing })).message).toContain(`cannot read ${missing}`);
  });

  test("an empty file, a list, several documents and invalid YAML are refused", () => {
    expect(configError(() => readConfigDocument(file(""))).issues).toEqual([
      "(root): the configuration must be a YAML mapping",
    ]);
    expect(configError(() => readConfigDocument(file("- a\n- b\n"))).issues).toEqual([
      "(root): the configuration must be a YAML mapping",
    ]);
    expect(configError(() => readConfigDocument(file(`${MINIMAL}---\n${MINIMAL}`))).issues[0]).toContain(
      "exactly one YAML document",
    );
    const invalid = configError(() => readConfigDocument(file("a: [1, 2\n")));
    expect(invalid.issues[0]).toStartWith("invalid YAML:");
    const duplicate = configError(() => readConfigDocument(file("a: 1\na: 2\n")));
    expect(duplicate.issues[0]).toStartWith("invalid YAML:");
  });
});

describe("parseSet", () => {
  test("parses values as YAML scalars", () => {
    expect(parseSet("a.b=false")).toEqual({ path: ["a", "b"], value: false });
    expect(parseSet("a=18080")).toEqual({ path: ["a"], value: 18080 });
    expect(parseSet('a="18080"')).toEqual({ path: ["a"], value: "18080" });
    expect(parseSet("a=Acme Corp")).toEqual({ path: ["a"], value: "Acme Corp" });
    expect(parseSet("a=x=y")).toEqual({ path: ["a"], value: "x=y" });
  });

  test("refuses an override without a value, with an empty segment or a reserved key, or with a collection", () => {
    expect(configError(() => parseSet("a.b")).issues).toEqual(["--set a.b: expected path=value"]);
    expect(configError(() => parseSet("a..b=1")).issues).toEqual(["--set a..b=1: the path has an empty segment"]);
    expect(configError(() => parseSet("=1")).issues).toEqual(["--set =1: the path has an empty segment"]);
    expect(configError(() => parseSet("__proto__.x=1")).issues).toEqual([
      "--set __proto__.x=1: the path uses the reserved key __proto__",
    ]);
    expect(configError(() => parseSet("a=[1, 2]")).issues).toEqual(["--set a=[1, 2]: the value must be a YAML scalar"]);
    expect(configError(() => parseSet("a={b: 1}")).issues).toEqual(["--set a={b: 1}: the value must be a YAML scalar"]);
    expect(configError(() => parseSet("a=[1")).issues[0]).toStartWith("--set a=[1: invalid YAML:");
  });
});

describe("applyOverrides", () => {
  test("does not change the input document", () => {
    const doc = { a: { b: 1 } };
    const result = applyOverrides(doc, ["a.b=2", "c.d=3"]);
    expect(result).toEqual({ a: { b: 2 }, c: { d: 3 } });
    expect(doc).toEqual({ a: { b: 1 } });
  });

  test("refuses to descend through a scalar or a list", () => {
    expect(configError(() => applyOverrides({ a: 1 }, ["a.b=2"])).issues).toEqual([
      "--set a.b=2: a is not a mapping",
    ]);
    expect(configError(() => applyOverrides({ a: { b: [1] } }, ["a.b.c=2"])).issues).toEqual([
      "--set a.b.c=2: a.b is not a mapping",
    ]);
  });
});
