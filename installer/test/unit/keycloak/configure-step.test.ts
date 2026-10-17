import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hashInputs } from "../../../src/engine/graph";
import type { StepRun } from "../../../src/engine/step";
import { loadConfig } from "../../../src/config/load";
import { emptyState } from "../../../src/state/store";
import type { DockerContext } from "../../../src/steps/docker-context";
import {
  createdUsers,
  keycloakConfigureStep,
  keycloakInputsUnchanged,
  PASSWORD_FILES,
} from "../../../src/steps/keycloak-configure";
import { desiredFixture as installationFixture } from "../render/fixture";
import { desiredFixture, observedFixture } from "./fixture";

const configFile = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-minimal.yaml");

function run(): StepRun<DockerContext> {
  const context = { desired: installationFixture(), config: loadConfig({ file: configFile, sets: [] }) } as DockerContext;
  return { context, state: emptyState(), inputHash: "a".repeat(64) };
}

describe("keycloak-configure step", () => {
  test("a realm it cannot reach yet plans one action that names why, and a reachable one gets the planner's actions", async () => {
    const reason = "the managed Keycloak is not running and healthy yet, so apply the keycloak-deploy step first";
    expect(await keycloakConfigureStep.plan({ pending: reason }, run())).toEqual([
      {
        kind: "pending",
        reason,
        summary: "configure the clients, the client scope and the accounts in realm libredb",
      },
    ]);
    const actions = await keycloakConfigureStep.plan({ desired: desiredFixture(), observed: observedFixture("empty-realm") }, run());
    expect(actions).toHaveLength(15);
  });

  test("its inputs are JSON that holds the realm, the issuer, the URIs and the accounts but no secret", () => {
    const inputs = keycloakConfigureStep.inputs(run().context);
    expect(hashInputs(inputs)).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs).toEqual({
      realm: "libredb",
      issuer: "https://auth.libredb.test/realms/libredb",
      clients: installationFixture().clients,
      firstAdmin: { enabled: true, username: "libredb-admin" },
      userManager: { enabled: true, username: "libredb-user-manager" },
    });
  });

  test("a run that skips the converge for want of the customer's admin credential plans nothing and records why", async () => {
    const warnings: string[] = [];
    const skipping = run();
    skipping.context.warn = (message) => warnings.push(message);
    const note = "keycloak-configure: skipped, because keycloak.external.adminPasswordEnv names X, which is not set";
    expect(await keycloakConfigureStep.plan({ skipped: note }, skipping)).toEqual([]);
    expect(warnings).toEqual([note]);
  });

  test("the inputs count as unchanged only when the step last converged the realm with them", () => {
    const { context } = run();
    const state = emptyState();
    expect(keycloakInputsUnchanged(context, state)).toBe(false);
    state.steps["keycloak-configure"] = {
      result: "applied",
      finishedAt: "2026-10-15T12:00:00.000Z",
      inputHash: hashInputs(keycloakConfigureStep.inputs(context)),
    };
    expect(keycloakInputsUnchanged(context, state)).toBe(true);
    state.steps["keycloak-configure"] = { result: "failed", finishedAt: "2026-10-15T12:05:00.000Z" };
    expect(keycloakInputsUnchanged(context, state)).toBe(false);
  });

  test("the accounts' temporary passwords live in root-only files under /opt/libredb/secrets, and the state names the accounts it created", () => {
    expect(PASSWORD_FILES).toEqual({
      "first-admin": "/opt/libredb/secrets/first-admin.txt",
      "user-manager": "/opt/libredb/secrets/user-manager.txt",
    });
    const state = emptyState();
    state.ownership.push(
      { kind: "keycloak-user", name: "libredb-admin", step: "keycloak-configure" },
      { kind: "postgres-role", name: "libredb_owner", step: "postgres-provision" },
    );
    expect(createdUsers(state)).toEqual(["libredb-admin"]);
  });
});
