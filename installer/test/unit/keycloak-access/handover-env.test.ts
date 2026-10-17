import { describe, expect, test } from "bun:test";
import { consoleText } from "../../../src/cli/commands/keycloak-console";
import { keycloakEnvContent, parseEnvFile } from "../../../src/steps/keycloak-handover";

describe("keycloak env file", () => {
  test("holds the bootstrap client until the handover, and only the database password after it", () => {
    expect(keycloakEnvContent("db-password", "bootstrap-secret")).toBe(
      "KC_DB_PASSWORD=db-password\n" +
        "KC_BOOTSTRAP_ADMIN_CLIENT_ID=libredb-bootstrap\n" +
        "KC_BOOTSTRAP_ADMIN_CLIENT_SECRET=bootstrap-secret\n",
    );
    expect(keycloakEnvContent("db-password", undefined)).toBe("KC_DB_PASSWORD=db-password\n");
  });

  test("parseEnvFile reads KEY=value lines, keeps '=' inside values and skips blank and comment lines", () => {
    expect([...parseEnvFile("# comment\nA=1\n\nB=x=y\n")]).toEqual([
      ["A", "1"],
      ["B", "x=y"],
    ]);
    expect(() => parseEnvFile("not a pair\n")).toThrow("an env file line is not of the form KEY=value");
  });
});

describe("keycloak console", () => {
  test("prints the realm console URL on the loopback admin port and the SSH tunnel to it", () => {
    expect(consoleText({ adminPort: 18080, realm: "libredb", host: "db1.corp", user: "ops" })).toBe(
      [
        "Realm console: http://127.0.0.1:18080/admin/libredb/console/",
        "It listens only on this host's loopback interface. From a remote workstation, open an SSH tunnel first:",
        "  ssh -N -L 18080:127.0.0.1:18080 ops@db1.corp",
        "then open the same URL in the workstation's browser.",
        "",
      ].join("\n"),
    );
  });
});
