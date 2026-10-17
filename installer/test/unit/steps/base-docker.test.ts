import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import type { DockerInstallation } from "../../../src/config/schema";
import { BASE_DIRECTORIES } from "../../../src/docker/layout";
import { computeDesired } from "../../../src/model/desired";
import { emptyState } from "../../../src/state/store";
import { baseDockerStep } from "../../../src/steps/base-docker";
import type { DockerContext } from "../../../src/steps/docker-context";
import { manifestFixture } from "../release/fixture";

const CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");

type BaseObservation = Parameters<typeof baseDockerStep.plan>[0];

/** What base observes on a fresh host, with the renewal timer as given: undefined when the host does not run systemd. */
function observation(timer: BaseObservation["renewal"]["timer"]): BaseObservation {
  return {
    directories: BASE_DIRECTORIES.map(() => undefined),
    networks: [],
    bundle: undefined,
    bundleObserved: undefined,
    systemd: undefined,
    renewal: {
      source: { path: "/usr/local/bin/libredb-installer", sha256: "a".repeat(64) },
      copy: undefined,
      appliedConfig: {
        spec: { path: "/opt/libredb/libredb.yaml", content: "mode: docker\n", mode: 0o600, uid: 0, gid: 0 },
        observed: undefined,
      },
      timer,
    },
  };
}

function run(warnings: string[]) {
  const config = loadConfig({ file: CONFIG, sets: [] }) as DockerInstallation;
  const context = { config, desired: computeDesired(config, manifestFixture()), warn: (message: string) => warnings.push(message) };
  return { context: context as unknown as DockerContext, state: emptyState(), inputHash: "a".repeat(64) };
}

describe("the renewal timer of the base step", () => {
  test("on a host that does not run systemd, base plans no timer and warns that nothing renews the certificates", async () => {
    const warnings: string[] = [];
    const actions = await baseDockerStep.plan(observation(undefined), run(warnings));
    expect(actions.map((action) => action.summary)).not.toContain("enable and start libredb-tls-renew.timer");
    expect(warnings).toEqual([
      "no libredb-tls-renew.timer was installed, because the host does not run systemd (/run/systemd/system does not " +
        "exist), so nothing renews the certificates automatically: run '/opt/libredb/bin/libredb-installer apply " +
        "--renew-certificates --yes -c /opt/libredb/libredb.yaml' once a year, as the timer would",
    ]);
  });

  test("on a host that runs systemd, base enables the timer and warns about nothing", async () => {
    const warnings: string[] = [];
    const actions = await baseDockerStep.plan(observation({ units: [], enabled: false, active: false }), run(warnings));
    expect(actions.map((action) => action.summary)).toContain("enable and start libredb-tls-renew.timer");
    expect(warnings).toEqual([]);
  });
});
