// NO_PROXY: the apps must reach every endpoint host, PostgreSQL and in-cluster services directly, never
// through network.httpsProxy.
import type { DesiredInstallation, Endpoint } from "./desired";

/**
 * Every endpoint host, then `others`, the PostgreSQL host, `.svc`, `.cluster.local`, `localhost` and `127.0.0.1`,
 * each once.
 */
export function noProxyHosts(
  hosts: Readonly<Record<Endpoint, string>>,
  postgresHost: string,
  others: readonly string[] = [],
): string[] {
  const all = [hosts.platform, hosts.studio, hosts.auth, ...others, postgresHost, ".svc", ".cluster.local", "localhost", "127.0.0.1"];
  return [...new Set(all)];
}

/** The NO_PROXY value: the hosts of noProxyHosts joined by commas. */
export function renderNoProxy(
  hosts: Readonly<Record<Endpoint, string>>,
  postgresHost: string,
  others: readonly string[] = [],
): string {
  return noProxyHosts(hosts, postgresHost, others).join(",");
}

/**
 * The hosts the apps reach besides the endpoints: the host of keycloak.external.adminUrl, where Platform calls the
 * Admin API of an external Keycloak whose site serves it apart from the public URL.
 */
export function keycloakAdminHosts(desired: Pick<DesiredInstallation, "keycloak">): string[] {
  const { managed, platformAdminUrl } = desired.keycloak;
  return managed || platformAdminUrl === undefined ? [] : [new URL(platformAdminUrl).hostname];
}
