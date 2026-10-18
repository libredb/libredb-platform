import { parseInstallation } from "../../../src/config/schema";
import { computeDesired, type DesiredInstallation } from "../../../src/model/desired";
import { manifestFixture } from "../release/fixture";

/** The desired model of a Docker install on the example hosts, with the given configuration overrides. */
export function desiredFixture(
  overrides: Record<string, unknown> = {},
  logoutHintVerified = false,
): DesiredInstallation {
  const config = parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: {
      hosts: { platform: "platform.example.com", studio: "studio.example.com", auth: "auth.example.com" },
    },
    platform: { organizationName: "Acme Corp", licenseFile: "/etc/libredb/platform.license" },
    ...overrides,
  });
  const manifest = manifestFixture();
  manifest.studio.logoutHintVerified = logoutHintVerified;
  return computeDesired(config, manifest);
}

export const POSTGRES = { host: "postgres", port: 5432 };
