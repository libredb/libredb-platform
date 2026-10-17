// The configurations this installer build can apply in Docker mode. It deploys the edge, a managed or an external
// PostgreSQL and either a managed Keycloak or the Keycloak objects of the apps in a reused realm of the customer's
// Keycloak, in every TLS mode, so any other choice is refused up front instead of half applied.
import type { LibreDBInstallation } from "../config/schema";

export function dockerSupportIssues(config: LibreDBInstallation): string[] {
  const issues: string[] = [];
  if (config.mode !== "docker") {
    issues.push(`mode: this installer build applies mode docker only, and the configuration sets ${config.mode}`);
    return issues;
  }
  return issues;
}
