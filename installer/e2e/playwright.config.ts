// The browser specs of the installer, run against an installation of test/fixtures/configs/docker.yaml, the
// configuration the Docker end-to-end tests apply: `bunx playwright test --config e2e/playwright.config.ts --project
// hostnames`, and the specs of the ports style against one of test/fixtures/configs/docker-ports.yaml with
// `--project ports`. The browser resolves the .test hostnames as the host does, through /etc/hosts on the CI runner, and
// LIBREDB_E2E_HOST_ADDRESS maps them to the address of another host instead, such as a Docker-in-Docker container
// that holds the installation. The edge serves leaves of the installer's internal CA, which the browser does not
// trust, so the specs accept them; the Docker end-to-end tests check the TLS chain against the CA bundle.
import { defineConfig, devices } from "@playwright/test";

const hostAddress = process.env.LIBREDB_E2E_HOST_ADDRESS;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // The specs share one installation and its accounts, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 3 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "https://platform.libredb.test",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    ...(hostAddress === undefined || hostAddress === ""
      ? {}
      : { launchOptions: { args: [`--host-resolver-rules=MAP *.libredb.test ${hostAddress}`] } }),
  },
  // The specs of an installation in the hostnames style, and those of the ports style (ports-*.spec.ts), each run
  // against an installation of their own style: `--project hostnames` or `--project ports`. The first admin's first
  // login, platform-login.spec.ts, runs first as the project first-login that hostnames depends on, and every other spec
  // of the hostnames style signs in as that admin, who then holds the one admin seat of the license that the end-to-end
  // tests install; `--no-deps` skips it against an installation whose first admin already signed in.
  projects: [
    { name: "first-login", testMatch: "platform-login.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "hostnames",
      testIgnore: ["ports-*.spec.ts", "platform-login.spec.ts"],
      dependencies: ["first-login"],
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "ports", testMatch: "ports-*.spec.ts", use: { ...devices["Desktop Chrome"] } },
  ],
});
