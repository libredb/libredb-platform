// The browser specs of the Helm chart, run against an installation on a kind cluster that run-e2e.sh made with the
// hostnames *.libredb.test, which Traefik serves on 127.0.0.1:443:
//   cd installer && bunx playwright test --config e2e/kubernetes/playwright.config.ts
// The browser maps every *.libredb.test name to 127.0.0.1 and trusts nothing it is not told to: the ingress serves
// leaves of the installation's internal CA, which run-e2e.sh checks with curl against the CA, so the browser accepts
// them as the installer's own browser specs do.
// On a cluster whose hosts resolve publicly, such as OpenShift's apps domain, LIBREDB_E2E_PLATFORM_URL and
// LIBREDB_E2E_STUDIO_URL name the two apps and the browser resolves them as it would anywhere.
import { defineConfig, devices } from "@playwright/test";
import { PLATFORM_URL } from "./k8s";

export default defineConfig({
  testDir: ".",
  // Not *.spec.ts, so the Docker suite of e2e/playwright.config.ts never picks this one up.
  testMatch: "*.k8s.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 4 * 60_000,
  reporter: [["list"]],
  outputDir: process.env.LIBREDB_E2E_OUTPUT_DIR ?? "test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: PLATFORM_URL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: process.env.LIBREDB_E2E_PLATFORM_URL ? [] : ["--host-resolver-rules=MAP *.libredb.test 127.0.0.1"] },
  },
});
