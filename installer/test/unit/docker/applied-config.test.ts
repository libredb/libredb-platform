import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import { appliedConfigFile, renderAppliedConfig } from "../../../src/docker/applied-config";
import { APPLIED_CONFIG_FILE } from "../../../src/docker/layout";

const fixture = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-minimal.yaml");

describe("the applied configuration", () => {
  test("holds the configuration with its --set overrides, so the renewal timer applies what the operator applied", () => {
    const config = loadConfig({ file: fixture, sets: ["images.registry=registry.example.com/libredb"] });
    const dir = mkdtempSync(join(tmpdir(), "renewal-applied-"));
    try {
      const copy = join(dir, "libredb.yaml");
      writeFileSync(copy, renderAppliedConfig(config, "/srv/install"));
      expect(loadConfig({ file: copy })).toEqual(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads back the external TLS proxies as a list and the provided files as absolute paths", () => {
    const external = loadConfig({
      file: join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-tls.yaml"),
      sets: ["tls.external.httpPort=8081"],
    });
    const provided = loadConfig({
      file: join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-provided.yaml"),
      sets: ["tls.provided.studio.keyFile=certs/studio.key"],
    });
    const dir = mkdtempSync(join(tmpdir(), "tls-applied-"));
    try {
      const copy = join(dir, "libredb.yaml");
      writeFileSync(copy, renderAppliedConfig(external, "/srv/install"));
      expect(loadConfig({ file: copy }).tls.external).toEqual({ httpPort: 8081, trustedProxies: ["10.213.0.10/32"] });
      writeFileSync(copy, renderAppliedConfig(provided, "/srv/install"));
      expect(loadConfig({ file: copy }).tls.provided?.studio.keyFile).toBe("/srv/install/certs/studio.key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps platform.licenseFile as an absolute path, so the renewal timer's apply reads the license file of the last apply", () => {
    const relative = loadConfig({ file: fixture, sets: ["platform.licenseFile=licenses/acme.license"] });
    const absolute = loadConfig({ file: fixture, sets: ["platform.licenseFile=/etc/libredb/acme.license"] });
    const dir = mkdtempSync(join(tmpdir(), "license-applied-"));
    try {
      const copy = join(dir, "libredb.yaml");
      writeFileSync(copy, renderAppliedConfig(relative, "/srv/install"));
      expect(loadConfig({ file: copy }).platform.licenseFile).toBe("/srv/install/licenses/acme.license");
      writeFileSync(copy, renderAppliedConfig(absolute, "/srv/install"));
      expect(loadConfig({ file: copy }).platform.licenseFile).toBe("/etc/libredb/acme.license");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves every relative file reference against the directory apply ran in, and keeps absolute ones", () => {
    const relative = loadConfig({ file: fixture, sets: ["tls.caBundleFile=certs/acme-ca.crt"] });
    expect(renderAppliedConfig(relative, "/srv/install")).toContain("caBundleFile: /srv/install/certs/acme-ca.crt\n");
    const absolute = loadConfig({ file: fixture, sets: ["tls.caBundleFile=/etc/acme/ca.crt"] });
    expect(renderAppliedConfig(absolute, "/srv/install")).toContain("caBundleFile: /etc/acme/ca.crt\n");
  });

  test("is a root-only file at /opt/libredb/libredb.yaml", () => {
    const config = loadConfig({ file: fixture });
    expect(appliedConfigFile(config, "/srv/install")).toEqual({
      path: "/opt/libredb/libredb.yaml",
      content: renderAppliedConfig(config, "/srv/install"),
      mode: 0o600,
      uid: 0,
      gid: 0,
    });
    expect(APPLIED_CONFIG_FILE).toBe("/opt/libredb/libredb.yaml");
  });
});
