// Renders the Caddyfile of the Docker edge: one TLS site per public endpoint the edge serves, on its host and port,
// each with the leaf certificate of its host and a reverse proxy to the service inside the compose network. In
// `tls.mode: external` the sites are plain HTTP on one port behind the customer's TLS proxy. The auth site forwards
// only the realm and resource paths, so the Keycloak admin console and the master realm stay internal.
import { join } from "node:path";
import { baseUrl, type DesiredInstallation } from "../model/desired";

/** The directory the edge container reads its Caddyfile from, mounted read-only at /etc/caddy. */
export const EDGE_CONFIG_DIR = "/opt/libredb/edge";
export const CADDYFILE = join(EDGE_CONFIG_DIR, "Caddyfile");

/** The host directory with the edge leaves, mounted read-only at EDGE_TLS_MOUNT. */
export const EDGE_TLS_DIR = "/opt/libredb/tls/edge";
export const EDGE_TLS_MOUNT = "/etc/libredb/tls";

/** The leaf certificate chain and key file names of one public hostname inside the edge TLS directory. */
export function edgeLeafFiles(host: string): { certificate: string; key: string } {
  return { certificate: `${host}.crt`, key: `${host}.key` };
}

/**
 * A raw request target whose path, before any query, contains `..`, `;`, a backslash, or a percent-encoded dot,
 * slash or backslash. Caddy matches paths on its own reading while Keycloak resolves the raw path it receives, so such
 * a path, like `/realms/<realm>/..;/master/`, could reach the master realm or the admin console. The
 * pattern is RE2 syntax, which Caddy uses, and means the same in JavaScript.
 */
export const NON_CANONICAL_PATH = "^[^?]*(\\.\\.|;|\\\\|%2[eEfF]|%5[cC])";

export function renderCaddyfile(desired: DesiredInstallation): string {
  const { edge } = desired;
  // The certificates are files the installer writes, or the upstream proxy holds them, so Caddy manages none and
  // redirects nothing: the edge publishes only its own ports.
  const lines = ["{", "\tauto_https off"];
  if (edge.scheme === "http") {
    // Behind an upstream proxy the edge passes its X-Forwarded-Proto and X-Forwarded-Host on to the apps and Keycloak,
    // which it does only for a trusted proxy; for any other client it sets them from its own plain HTTP request.
    lines.push("\tservers {", `\t\ttrusted_proxies static ${edge.trustedProxies.join(" ")}`, "\t}");
  }
  lines.push("}");
  for (const site of edge.sites) {
    const files = edgeLeafFiles(site.host);
    // The site's public URL, whose port Caddy listens on inside the edge container, or behind an upstream proxy the
    // site's host on the edge's one plain HTTP port.
    const address = edge.scheme === "https" ? baseUrl(site.host, site.port) : `http://${site.host}:${edge.ports[0]}`;
    const tls = edge.scheme === "https" ? [`\ttls ${EDGE_TLS_MOUNT}/${files.certificate} ${EDGE_TLS_MOUNT}/${files.key}`] : [];
    if (site.endpoint === "auth") {
      lines.push(
        "",
        `${address} {`,
        ...tls,
        // {http.request.orig_uri} is the request target as the client sent it, before Caddy decodes or cleans it.
        `\t@noncanonical vars_regexp {http.request.orig_uri} \`${NON_CANONICAL_PATH}\``,
        "\thandle @noncanonical {",
        "\t\trespond 400",
        "\t}",
        `\t@keycloak path /realms/${desired.realm}/* /resources/*`,
        "\thandle @keycloak {",
        `\t\treverse_proxy ${site.upstream}`,
        "\t}",
        "\thandle {",
        "\t\trespond 404",
        "\t}",
        "}",
      );
    } else {
      lines.push("", `${address} {`, ...tls, `\treverse_proxy ${site.upstream}`, "}");
    }
  }
  return `${lines.join("\n")}\n`;
}
