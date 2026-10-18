import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json";
import release from "../../../release/release.config.json";
import { main, type Output } from "../../../src/cli/main";

// The scratch directories of the output path tests, removed when the file ends, under the real path of the temporary
// directory, because an output path must not contain a symbolic link.
const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), "libredb-cli-output-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** A file with mode 0600 that stands in for a file such as /etc/shadow, which a planted link points at. */
function canary(dir: string): string {
  const path = join(dir, "canary");
  writeFileSync(path, "canary\n");
  chmodSync(path, 0o600);
  return path;
}

/** An export directory whose export file is a symbolic link to a canary, as another local user could plant it. */
function plantedExport(): { out: string; file: string; target: string } {
  const dir = mkdtempSync(join(scratchRoot, "export-"));
  const target = canary(dir);
  const out = join(dir, "export");
  mkdirSync(out, { mode: 0o755 });
  const file = join(out, "libredb-keycloak-export.json");
  symlinkSync(target, file);
  return { out, file, target };
}

function capture(): Output & { out: string; err: string } {
  const sink = {
    out: "",
    err: "",
    stdout(text: string) {
      sink.out += text;
    },
    stderr(text: string) {
      sink.err += text;
    },
  };
  return sink;
}

describe("cli", () => {
  test("version prints the installer version, the release version and both contract sets, and exits 0", async () => {
    const io = capture();
    const code = await main(["version"], io);
    expect(code).toBe(0);
    expect(io.out).toBe(
      `libredb-installer ${pkg.version}\nrelease ${release.version}\nplatformPublishes [1]\nstudioSupports [1]\n`,
    );
    expect(io.err).toBe("");
  });

  test("images list prints one upstream reference per image, each pinned by digest", async () => {
    const io = capture();
    const code = await main(["images", "list"], io);
    expect(code).toBe(0);
    const lines = io.out.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`ghcr.io/libredb/libredb-platform@${release.images.platform.digest}`);
    for (const line of lines) expect(line).toMatch(/^[^@\s]+@sha256:[0-9a-f]{64}$/);
  });

  test("images list -c with images.registry prints the mirror references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "images-list-"));
    const file = join(dir, "libredb.yaml");
    writeFileSync(
      file,
      [
        "apiVersion: install.libredb.org/v1",
        "kind: LibreDBInstallation",
        "metadata: {name: acme}",
        "mode: docker",
        "endpoints: {hosts: {platform: platform.corp, studio: studio.corp, auth: auth.corp}}",
        "platform: {organizationName: Acme, licenseFile: /etc/libredb/platform.license}",
        "",
      ].join("\n"),
    );
    const io = capture();
    const code = await main(["images", "list", "-c", file, "--set", "images.registry=harbor.corp/libredb"], io);
    expect(code).toBe(0);
    expect(io.out.split("\n")[1]).toBe(`harbor.corp/libredb/libredb-studio@${release.images.studio.digest}`);
  });

  test("images without list, with an unknown flag or with --set but no -c prints the usage and exits 2", async () => {
    for (const argv of [["images"], ["images", "push"], ["images", "list", "--bogus"], ["images", "list", "--set", "a=b"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.err).toContain("Usage: libredb-installer images list");
    }
  });

  test("images list with an invalid configuration exits 2 naming the problem", async () => {
    const io = capture();
    const code = await main(["images", "list", "-c", "/nonexistent/libredb.yaml"], io);
    expect(code).toBe(2);
    expect(io.err).toContain("cannot read /nonexistent/libredb.yaml");
  });

  test("an unknown command prints the usage and exits 2", async () => {
    const io = capture();
    const code = await main(["frobnicate"], io);
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain("unknown command 'frobnicate'");
    expect(io.err).toContain("Usage: libredb-installer <command>");
  });

  test("verify without -c, with an unknown flag or with an output other than text or json prints its usage and exits 2", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    for (const argv of [["verify"], ["verify", "--bogus"], ["verify", "-c", config, "--output", "yaml"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.out).toBe("");
      expect(io.err).toContain("Usage: libredb-installer verify -c <libredb.yaml>");
    }
  });

  test("apply takes --renew-certificates, which plan and verify refuse with their usage", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    const usage = capture();
    expect(await main(["apply", "--renew-certificates"], usage)).toBe(2);
    expect(usage.err).toContain("apply: --config (-c) is required");
    expect(usage.err).toContain("[--renew-certificates]");
    for (const command of ["plan", "verify"]) {
      const io = capture();
      expect(await main([command, "-c", config, "--renew-certificates"], io)).toBe(2);
      expect(io.err).toContain("Unknown option '--renew-certificates'");
    }
  });

  test("keycloak console -c prints the realm console URL of the configured port and realm", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    const io = capture();
    expect(await main(["keycloak", "console", "-c", config, "--set", "keycloak.adminPort=28080"], io)).toBe(0);
    expect(io.out).toContain("Realm console: http://127.0.0.1:28080/admin/libredb/console/\n");
    expect(io.out).toContain("ssh -N -L 28080:127.0.0.1:28080 ");
    expect(io.err).toBe("");
  });

  test("keycloak without console, without -c or for an external Keycloak exits 2", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    for (const argv of [["keycloak"], ["keycloak", "admin"], ["keycloak", "console"], ["keycloak", "console", "--bogus"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.err).toContain("Usage: libredb-installer keycloak console");
      expect(io.err).toContain("Usage: libredb-installer keycloak export");
    }
    const external = capture();
    const externalConfig = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    expect(await main(["keycloak", "console", "-c", externalConfig], external)).toBe(2);
    expect(external.err).toContain("keycloak.mode is external");
    const missing = capture();
    expect(await main(["keycloak", "console", "-c", "/nonexistent/libredb.yaml"], missing)).toBe(2);
    expect(missing.err).toContain("invalid configuration");
  });

  test("keycloak export -o writes the LibreDB Keycloak objects of the configured realm and hosts, without a secret", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const out = join(mkdtempSync(join(tmpdir(), "libredb-cli-export-")), "export");
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "--output", out], io)).toBe(0);
    const file = join(out, "libredb-keycloak-export.json");
    expect(io.out).toContain(`Wrote ${file}`);
    expect(io.err).toBe("");
    const exported = JSON.parse(readFileSync(file, "utf8")) as { realm: string; issuer: string; requests: { summary: string }[] };
    expect(exported.realm).toBe("corp");
    expect(exported.issuer).toBe("https://auth.libredb.test:8443/realms/corp");
    expect(exported.requests[0]?.summary).toBe("create client libredb");
    expect(readFileSync(file, "utf8")).not.toContain('"secret"');
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  test("keycloak export refuses a symbolic link at the export file and leaves the file it points at unchanged", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const { out, file, target } = plantedExport();
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out], io)).toBe(2);
    expect(io.err).toBe(
      `keycloak export: ${file} is a symbolic link, which the installer never follows; pass --force to replace the ` +
        "link itself\n",
    );
    expect(io.out).toBe("");
    expect(readlinkSync(file)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("canary\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("keycloak export --force replaces a symbolic link at the export file instead of following it", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const { out, file, target } = plantedExport();
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out, "--force"], io)).toBe(0);
    expect(io.out).toContain(`Wrote ${file}`);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect((JSON.parse(readFileSync(file, "utf8")) as { realm: string }).realm).toBe("corp");
    expect(readFileSync(target, "utf8")).toBe("canary\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("keycloak export refuses an existing export file without --force and replaces it with --force", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const out = join(mkdtempSync(join(scratchRoot, "export-")), "export");
    mkdirSync(out, { mode: 0o755 });
    const file = join(out, "libredb-keycloak-export.json");
    writeFileSync(file, "an earlier export\n");
    chmodSync(file, 0o600);
    const refused = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out], refused)).toBe(2);
    expect(refused.err).toBe(`keycloak export: ${file} already exists; pass --force to replace it\n`);
    expect(readFileSync(file, "utf8")).toBe("an earlier export\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const forced = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out, "--force"], forced)).toBe(0);
    expect(forced.err).toBe("");
    expect((JSON.parse(readFileSync(file, "utf8")) as { realm: string }).realm).toBe("corp");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(out)).toEqual(["libredb-keycloak-export.json"]);
  });

  test("keycloak export refuses an output directory that is a symbolic link or not a directory, also with --force", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const dir = mkdtempSync(join(scratchRoot, "export-"));
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o755 });
    const link = join(dir, "export");
    symlinkSync(real, link);
    const file = join(dir, "export-file");
    writeFileSync(file, "not a directory\n");
    for (const force of [[], ["--force"]]) {
      const linked = capture();
      expect(await main(["keycloak", "export", "-c", config, "-o", link, ...force], linked)).toBe(2);
      expect(linked.err).toBe(
        `keycloak export: ${link} must not contain a symbolic link; it resolves to ${real}, so pass that instead\n`,
      );
      expect(linked.out).toBe("");
      const notDirectory = capture();
      expect(await main(["keycloak", "export", "-c", config, "-o", file, ...force], notDirectory)).toBe(2);
      expect(notDirectory.err).toBe(`keycloak export: ${file} exists but is not a directory\n`);
    }
    expect(readdirSync(real)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("not a directory\n");
  });

  test("keycloak export refuses an output directory below a symbolic link and creates nothing through it", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const dir = mkdtempSync(join(scratchRoot, "export-"));
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o755 });
    const link = join(dir, "link");
    symlinkSync(real, link);
    const out = join(link, "export");
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out], io)).toBe(2);
    expect(io.err).toBe(
      `keycloak export: ${out} must not contain a symbolic link; it resolves to ${join(real, "export")}, so pass ` +
        "that instead\n",
    );
    expect(readdirSync(real)).toEqual([]);
  });

  test("keycloak export refuses an output directory below one that others can write to without the sticky bit", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const shared = join(mkdtempSync(join(scratchRoot, "export-")), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", join(shared, "export")], io)).toBe(2);
    expect(io.err).toBe(
      `keycloak export: ${shared} is writable by its group and others without the sticky bit, so another user could ` +
        `redirect the path; run chmod go-w ${shared}, or name a path below a root-owned directory such as /root\n`,
    );
    expect(readdirSync(shared)).toEqual([]);
  });

  test("keycloak export names the missing parent of an output directory, which it does not create", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const dir = mkdtempSync(join(scratchRoot, "export-"));
    const out = join(dir, "missing", "export");
    const io = capture();
    expect(await main(["keycloak", "export", "-c", config, "-o", out], io)).toBe(2);
    expect(io.err).toBe(
      `keycloak export: ${out} cannot be created, because its parent ${join(dir, "missing")} does not exist; create ` +
        "the parent first\n",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("keycloak export without -o, without -c or for a managed Keycloak exits 2", async () => {
    const external = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-kc.yaml");
    const managed = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    for (const argv of [["keycloak", "export", "-c", external], ["keycloak", "export", "-o", "/tmp/x"], ["keycloak", "export", "--bogus"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.err).toContain("Usage: libredb-installer keycloak export");
    }
    const io = capture();
    expect(await main(["keycloak", "export", "-c", managed, "-o", "/tmp/x"], io)).toBe(2);
    expect(io.err).toContain("keycloak.mode is managed");
  });

  test("tls without export-ca or with an unknown option exits 2 with the usage", async () => {
    for (const argv of [["tls"], ["tls", "renew"], ["tls", "export-ca", "--bogus"], ["tls", "export-ca", "extra"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.err).toContain("Usage: libredb-installer tls export-ca [-o <file> [--force]]");
    }
  });

  test("tls export-ca --force without -o exits 2 with the usage", async () => {
    const io = capture();
    expect(await main(["tls", "export-ca", "--force"], io)).toBe(2);
    expect(io.err).toStartWith("tls export-ca: --force needs --output (-o)\n\n");
    expect(io.err).toContain("Usage: libredb-installer tls export-ca [-o <file> [--force]]");
    expect(io.out).toBe("");
  });

  test.skipIf(process.getuid?.() === 0)("tls export-ca without an installed internal CA exits 1 naming its file", async () => {
    const output = join(scratchRoot, "ca.crt");
    for (const argv of [["tls", "export-ca"], ["tls", "export-ca", "-o", output, "--force"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(1);
      expect(io.err).toStartWith("tls export-ca: ");
      expect(io.err).toContain("/opt/libredb/tls/ca/ca.crt");
      expect(io.out).toBe("");
    }
  });

  test("db-script needs -o and a configuration with an external PostgreSQL provisioned manually, and exits 2 otherwise", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    const external = ["--set", "postgres.mode=external", "--set", "postgres.external.host=pg.corp.example"];
    for (const argv of [["db-script"], ["db-script", "-c", config], ["db-script", "-c", config, "--bogus"]]) {
      const io = capture();
      expect(await main(argv, io)).toBe(2);
      expect(io.out).toBe("");
      expect(io.err).toContain("Usage: libredb-installer db-script -c <libredb.yaml>");
    }
    const managed = capture();
    expect(await main(["db-script", "-c", config, "-o", "/nonexistent/provision.sql"], managed)).toBe(2);
    expect(managed.err).toBe(
      "db-script: postgres.mode: db-script writes the DBA script of an external PostgreSQL server, and the " +
        "configuration sets managed\n",
    );
    const installer = capture();
    const sets = [...external, "--set", "postgres.external.adminUser=dba"];
    expect(await main(["db-script", "-c", config, ...sets, "-o", "/nonexistent/provision.sql"], installer)).toBe(2);
    expect(installer.err).toContain("postgres.external.provisioning: db-script writes the DBA script of provisioning manual");
    const invalid = capture();
    expect(await main(["db-script", "-c", config, ...external, "-o", "/nonexistent/provision.sql"], invalid)).toBe(2);
    expect(invalid.err).toContain("invalid configuration:\n  postgres.external.adminUser: provisioning installer needs");
  });

  // As root, db-script would open a Docker session on this host, so the case runs as another uid only.
  test.skipIf(process.getuid?.() === 0)("db-script takes --force and then needs root, like every command that changes the host (runs as another uid only)", async () => {
    const config = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
    const manual = [
      "--set",
      "postgres.mode=external",
      "--set",
      "postgres.external.host=pg.corp.example",
      "--set",
      "postgres.external.provisioning=manual",
    ];
    const io = capture();
    expect(await main(["db-script", "-c", config, ...manual, "-o", join(scratchRoot, "provision.sql"), "--force"], io)).toBe(3);
    expect(io.err).toBe(`db-script: preflight failed:\n  the installer must run as root, and it runs as uid ${process.getuid?.()}\n`);
    expect(readdirSync(scratchRoot)).not.toContain("provision.sql");
  });

  test("no command prints the usage and exits 2", async () => {
    const io = capture();
    const code = await main([], io);
    expect(code).toBe(2);
    expect(io.err).toContain("Usage: libredb-installer <command>");
  });
});
