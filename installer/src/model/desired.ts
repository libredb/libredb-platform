// The desired model: what one configuration and release manifest mean for the installation, computed once and
// read by every renderer, so the public URLs, the issuer and the OIDC URIs of the app clients have a single source.
import type { LibreDBInstallation } from "../config/schema";
import { effectiveImages } from "../release/images";
import type { ImageName, ReleaseManifest } from "../release/manifest";
import { POSTGRES_DOCKER_SERVICE, POSTGRES_KUBERNETES_SERVICE } from "../tls/plan";

export type Endpoint = "platform" | "studio" | "auth";

/** One public endpoint the edge serves: its host, its TLS port, and the in-network service it forwards to. */
export interface EdgeSite {
  endpoint: Endpoint;
  host: string;
  port: number;
  upstream: string;
}

/** The redirect and post-logout URIs of one OIDC client. */
export interface ClientUris {
  redirectUri: string;
  postLogoutRedirectUri: string;
}

export interface DesiredInstallation {
  /** `metadata.name` of the configuration. */
  name: string;
  mode: LibreDBInstallation["mode"];
  /** `endpoints.style`: a host per endpoint, or one host with a port per endpoint. */
  style: LibreDBInstallation["endpoints"]["style"];
  hosts: Record<Endpoint, string>;
  /** The TLS port of each endpoint on the edge: 443 for every endpoint in the hostnames style. */
  ports: Record<Endpoint, number>;
  /** The public base URL of each endpoint, without a trailing slash, with its port unless it is 443. */
  urls: Record<Endpoint, string>;
  realm: string;
  /** `https://<auth>/realms/<realm>`, the issuer both apps trust. */
  issuer: string;
  /** The app clients, and the mobile app's public client only while `mobile.enabled` is true. */
  clients: { studio: ClientUris; platform: ClientUris; mobile?: ClientUris };
  /**
   * The edge: its sites in endpoint order, the auth endpoint only for a managed Keycloak. It terminates TLS on the
   * distinct ports of its sites with every distinct site host as a network alias, or in `tls.mode: external` serves
   * plain HTTP on `tls.external.httpPort` behind an upstream proxy whose X-Forwarded-* headers it trusts from
   * `trustedProxies`, and holds no alias. `ports` are the ports it listens on and publishes.
   */
  edge: {
    sites: EdgeSite[];
    scheme: "https" | "http";
    ports: number[];
    aliases: string[];
    trustedProxies: string[];
  };
  /** The effective reference of every release image, pinned by digest. */
  images: Record<ImageName, string>;
  /** Whether the Docker install gets the systemd unit; always false in Kubernetes mode. */
  systemdUnit: boolean;
  /** `platform.organizationName`, the name of the one tenant the self-hosted seed creates. */
  organizationName: string;
  /** Days Platform keeps query events: `platform.queryLogRetentionDays`, or 90, Platform's default. */
  queryLogRetentionDays: number;
  /** `network.httpsProxy`, the proxy the apps use for outbound HTTPS, or undefined for none. */
  httpsProxy: string | undefined;
  /** The release manifest flag `studio.logoutHintVerified`, which allows Studio's OIDC_LOGOUT_HINT. */
  logoutHintVerified: boolean;
  /**
   * How Keycloak is reached besides the issuer. `adminUrl` is where the installer reaches the Admin API:
   * the loopback-only URL of a managed Keycloak's port 8080, through which the operator opens the admin console too,
   * or keycloak.external.adminUrl, else the base URL, of an external one. `platformAdminUrl` is Platform's
   * KEYCLOAK_ADMIN_URL: the in-network service of a managed Keycloak, keycloak.external.adminUrl of an external one,
   * or undefined, so that Platform derives the Admin API URL from the issuer.
   */
  keycloak: { managed: boolean; adminPort: number; adminUrl: string; platformAdminUrl: string | undefined };
  /** The PostgreSQL server every app URL names: the managed server's service, or the external server. */
  postgres: { managed: boolean; host: string; port: number };
}

/** The port of the managed PostgreSQL server on its network. */
export const MANAGED_POSTGRES_PORT = 5432;

/** The query event retention when the configuration sets none, equal to Platform's default. */
export const DEFAULT_QUERY_LOG_RETENTION_DAYS = 90;

// The port each application listens on inside its container.
const UPSTREAMS: Record<Endpoint, string> = {
  platform: "platform:3000",
  studio: "studio:3000",
  auth: "keycloak:8080",
};

const ENDPOINTS: readonly Endpoint[] = ["platform", "studio", "auth"];

/** The port of HTTPS, which a URL leaves out. */
export const HTTPS_PORT = 443;

function endpointAddresses(endpoints: LibreDBInstallation["endpoints"]) {
  if (endpoints.style === "hostnames") {
    return {
      hosts: { ...endpoints.hosts },
      ports: { platform: HTTPS_PORT, studio: HTTPS_PORT, auth: HTTPS_PORT },
    };
  }
  const host = endpoints.host;
  return { hosts: { platform: host, studio: host, auth: host }, ports: { ...endpoints.ports } };
}

/** The public base URL of a host and TLS port: the host alone on 443, and host:port on any other port. */
export const baseUrl = (host: string, port: number) => (port === HTTPS_PORT ? `https://${host}` : `https://${host}:${port}`);

/** The edge of the desired model: TLS on the ports of its sites, or plain HTTP behind an external TLS proxy. */
function edgeOf(config: LibreDBInstallation, sites: EdgeSite[]): DesiredInstallation["edge"] {
  const external = config.tls.external;
  if (config.tls.mode === "external" && external !== undefined) {
    return { sites, scheme: "http", ports: [external.httpPort], aliases: [], trustedProxies: [...external.trustedProxies] };
  }
  return {
    sites,
    scheme: "https",
    ports: [...new Set(sites.map((site) => site.port))],
    aliases: [...new Set(sites.map((site) => site.host))],
    trustedProxies: [],
  };
}

/** Computes the desired model for either endpoint style. */
export function computeDesired(config: LibreDBInstallation, manifest: ReleaseManifest): DesiredInstallation {
  const { hosts, ports } = endpointAddresses(config.endpoints);
  const external = config.keycloak.mode === "external" ? config.keycloak.external : undefined;
  const urls = {
    platform: baseUrl(hosts.platform, ports.platform),
    studio: baseUrl(hosts.studio, ports.studio),
    // An external Keycloak serves its own URL, whose host validation keeps equal to endpoints.hosts.auth.
    auth: external?.baseUrl ?? baseUrl(hosts.auth, ports.auth),
  };
  const realm = config.keycloak.realm;
  const loopbackAdminUrl = `http://127.0.0.1:${config.keycloak.adminPort}`;
  const served = ENDPOINTS.filter((endpoint) => endpoint !== "auth" || config.keycloak.mode === "managed");
  const sites = served.map((endpoint) => ({
    endpoint,
    host: hosts[endpoint],
    port: ports[endpoint],
    upstream: UPSTREAMS[endpoint],
  }));
  const images = Object.fromEntries(
    effectiveImages(manifest, config.images?.registry).map((image) => [image.name, image.reference]),
  ) as Record<ImageName, string>;
  return {
    name: config.metadata.name,
    mode: config.mode,
    style: config.endpoints.style,
    hosts,
    ports,
    urls,
    realm,
    issuer: `${urls.auth}/realms/${realm}`,
    clients: {
      studio: {
        redirectUri: `${urls.studio}/api/auth/oidc/callback`,
        postLogoutRedirectUri: `${urls.studio}/login`,
      },
      platform: {
        redirectUri: `${urls.platform}/api/auth/callback/keycloak`,
        postLogoutRedirectUri: `${urls.platform}/login`,
      },
      ...(config.mobile?.enabled === true
        ? {
            mobile: {
              redirectUri: config.mobile.redirectUri,
              postLogoutRedirectUri: config.mobile.postLogoutRedirectUri,
            },
          }
        : {}),
    },
    edge: edgeOf(config, sites),
    images,
    systemdUnit: config.mode === "docker" && config.docker.systemdUnit,
    organizationName: config.platform.organizationName,
    queryLogRetentionDays: config.platform.queryLogRetentionDays ?? DEFAULT_QUERY_LOG_RETENTION_DAYS,
    httpsProxy: config.network?.httpsProxy,
    logoutHintVerified: manifest.studio.logoutHintVerified,
    keycloak: {
      managed: external === undefined,
      adminPort: config.keycloak.adminPort,
      adminUrl: external === undefined ? loopbackAdminUrl : (external.adminUrl ?? external.baseUrl),
      platformAdminUrl: external === undefined ? `http://${UPSTREAMS.auth}` : external.adminUrl,
    },
    postgres:
      config.postgres.mode === "external"
        ? { managed: false, host: config.postgres.external.host, port: config.postgres.external.port }
        : {
            managed: true,
            host: config.mode === "docker" ? POSTGRES_DOCKER_SERVICE : POSTGRES_KUBERNETES_SERVICE,
            port: MANAGED_POSTGRES_PORT,
          },
  };
}
