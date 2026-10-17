import { describe, expect, test } from "bun:test";
import type { ComposeContainer } from "../../../src/adapters/docker";
import type { StepRun } from "../../../src/engine/step";
import { KEYCLOAK_ENV_FILE } from "../../../src/render/compose";
import { emptyState } from "../../../src/state/store";
import type { DockerContext } from "../../../src/steps/docker-context";
import { keycloakDeployStep, type KeycloakDeployObservation } from "../../../src/steps/keycloak-deploy";
import { desiredFixture } from "../render/fixture";

const HASH = "a".repeat(64);
const ENV = { path: KEYCLOAK_ENV_FILE, content: "KC_DB_PASSWORD=x\n", mode: 0o600, uid: 0, gid: 0 };
const HEALTHY: ComposeContainer = {
  id: "1",
  name: "libredb-keycloak-1",
  service: "keycloak",
  state: "running",
  health: "healthy",
  image: "keycloak",
};

function run(recorded: string | undefined): StepRun<DockerContext> {
  const state = emptyState();
  if (recorded !== undefined) {
    state.steps["keycloak-deploy"] = { result: "applied", finishedAt: "2026-10-15T00:00:00.000Z", inputHash: recorded };
  }
  return { context: { desired: desiredFixture() } as DockerContext, state, inputHash: HASH };
}

function observation(options: {
  env: "missing" | "same" | "changed";
  container: ComposeContainer | undefined;
  handoverPending: boolean;
}): KeycloakDeployObservation {
  const content = options.env === "same" ? ENV.content : "KC_DB_PASSWORD=old\n";
  const observedEnv =
    options.env === "missing" ? undefined : { kind: "file" as const, mode: 0o600, uid: 0, gid: 0, content };
  return {
    managed: true,
    handoverPending: options.handoverPending,
    directories: [],
    files: [{ spec: ENV, observed: observedEnv }],
    container: options.container,
  };
}

const summaries = async (observed: KeycloakDeployObservation, stepRun: StepRun<DockerContext>) =>
  (await keycloakDeployStep.plan(observed, stepRun)).map((action) => action.summary);

describe("keycloak-deploy plan", () => {
  test("a first run writes the env file, starts keycloak and then hands access over", async () => {
    expect(await summaries(observation({ env: "missing", container: undefined, handoverPending: true }), run(undefined))).toEqual([
      `create ${KEYCLOAK_ENV_FILE}`,
      "start keycloak",
      "hand Keycloak access over from the bootstrap client libredb-bootstrap to libredb-installer in realm libredb",
    ]);
  });

  test("a converged Keycloak after the handover plans nothing", async () => {
    expect(await summaries(observation({ env: "same", container: HEALTHY, handoverPending: false }), run(HASH))).toEqual([]);
  });

  test("a changed database password in the env file recreates keycloak", async () => {
    expect(await summaries(observation({ env: "changed", container: HEALTHY, handoverPending: false }), run(HASH))).toEqual([
      `update ${KEYCLOAK_ENV_FILE}`,
      "recreate keycloak with its changed env file",
    ]);
  });

  test("an external Keycloak plans nothing", async () => {
    expect(await keycloakDeployStep.plan({ managed: false }, run(undefined))).toEqual([]);
  });
});
