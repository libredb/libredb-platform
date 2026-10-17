import { join } from "node:path";
import { applyOverrides, loadConfig, readConfigDocument } from "../../../src/config/load";
import { parseInstallation } from "../../../src/config/schema";
import { computeDesired, type DesiredInstallation } from "../../../src/model/desired";
import type { ComposeTrust } from "../../../src/render/compose";
import { manifestFixture } from "../release/fixture";

const root = join(import.meta.dir, "..", "..", "..");

/** The desired model of the minimal Docker fixture with the release manifest fixture, plus `--set` overrides. */
export function desiredFixture(sets: readonly string[] = []): DesiredInstallation {
  const config = loadConfig({ file: join(root, "test", "fixtures", "configs", "docker-minimal.yaml"), sets });
  return computeDesired(config, manifestFixture());
}

/**
 * The desired model of the minimal Docker fixture in tls.mode external behind an upstream proxy at 192.0.2.10, plus
 * `--set` overrides. The proxy is set in the document, because a `--set` value is a scalar and trustedProxies a list.
 */
export function externalDesiredFixture(sets: readonly string[] = []): DesiredInstallation {
  const document = readConfigDocument(join(root, "test", "fixtures", "configs", "docker-minimal.yaml"));
  const tls = { mode: "external", caBundleFile: "/etc/corp/ca.crt", external: { trustedProxies: ["192.0.2.10/32"] } };
  return computeDesired(parseInstallation(applyOverrides({ ...document, tls }, sets)), manifestFixture());
}

/** The desired model of the ports-style Docker fixture, Platform on 443, Studio on 8443 and Keycloak on 9443. */
export function portsDesiredFixture(sets: readonly string[] = []): DesiredInstallation {
  const config = loadConfig({ file: join(root, "test", "fixtures", "configs", "docker-ports.yaml"), sets });
  return computeDesired(config, manifestFixture());
}

export const golden = (name: string) => join(root, "test", "golden", name);

/** Trust labels for renderings that do not test them: a CA bundle and edge certificates that exist. */
export const TRUST_FIXTURE: ComposeTrust = { caSha256: "c".repeat(64), tlsSha256: "e".repeat(64) };
