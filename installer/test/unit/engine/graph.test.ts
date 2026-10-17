import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstallation } from "../../../src/config/schema";
import { applyGraph, hashInputs, planGraph, StepSelectionError } from "../../../src/engine/graph";
import type { Step, StepName, StepRun } from "../../../src/engine/step";
import { FileStateStore } from "../../../src/state/file-store";
import { immutableFieldsOf, UnsafeChangeError, type ImmutableFields } from "../../../src/state/immutable";
import { emptyState, type StateStore } from "../../../src/state/store";

const root = mkdtempSync(join(tmpdir(), "libredb-installer-graph-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshStore(): FileStateStore {
  counter += 1;
  return new FileStateStore(join(root, `run-${counter}`, "state", "state.json"));
}

// The fifteen steps in the order installer/README.md documents, written out so that the expected order does not come
// from the code under test.
const SPEC_ORDER: readonly StepName[] = [
  "preflight",
  "images",
  "secrets",
  "tls",
  "base",
  "edge-deploy",
  "postgres-deploy",
  "postgres-provision",
  "keycloak-deploy",
  "keycloak-configure",
  "platform-migrate",
  "platform-deploy",
  "studio-deploy",
  "verify",
  "report",
];

// SHA-256 of {"value":"r1"}, the canonical JSON of a fake step's inputs, computed with sha256sum.
const R1_INPUT_HASH = "cb2262c256de360e69eeaf1b19656b25cc65421d6f938da5bc9db212cfee5a44";

const NOW = new Date("2026-10-15T08:00:00.000Z");
const now = () => NOW;

function installationOf(overrides: Record<string, unknown> = {}): ImmutableFields {
  return immutableFieldsOf(
    parseInstallation({
      apiVersion: "install.libredb.org/v1",
      kind: "LibreDBInstallation",
      metadata: { name: "acme" },
      mode: "docker",
      endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
      platform: { organizationName: "Acme" },
      ...overrides,
    }),
  );
}

interface Context {
  readonly desired: Readonly<Partial<Record<StepName, string>>>;
}

function desiredAll(value: string): Context {
  return { desired: Object.fromEntries(SPEC_ORDER.map((name) => [name, value])) };
}

/** A fake live system in which each step owns one value and converges it on the value its context desires. */
class FakeSystem {
  readonly values = new Map<StepName, string>();
  readonly calls: string[] = [];

  step(name: StepName, onApply?: (run: StepRun<Context>) => Promise<void>): Step<Context, string | undefined> {
    return {
      name,
      inputs: (context) => ({ value: context.desired[name] ?? null }),
      observe: async () => {
        this.calls.push(`${name} observe`);
        return this.values.get(name);
      },
      plan: (observed, run) => {
        this.calls.push(`${name} plan`);
        const wanted = run.context.desired[name];
        return wanted === undefined || observed === wanted ? [] : [{ summary: `set ${name} to ${wanted}` }];
      },
      apply: async (_actions, run) => {
        this.calls.push(`${name} apply`);
        await onApply?.(run);
        this.values.set(name, run.context.desired[name] as string);
      },
    };
  }

  steps(order: readonly StepName[] = SPEC_ORDER): Step<Context, string | undefined>[] {
    return order.map((name) => this.step(name));
  }

  callsOf(phase: "observe" | "plan" | "apply"): string[] {
    return this.calls.filter((call) => call.endsWith(` ${phase}`)).map((call) => call.slice(0, -phase.length - 1));
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("applyGraph", () => {
  test("a second run with unchanged inputs plans zero actions", async () => {
    const system = new FakeSystem();
    const store = freshStore();
    const installation = installationOf();

    const first = await applyGraph({ steps: system.steps(), store, context: desiredAll("r1"), installation, now });
    expect(first.map((step) => step.name)).toEqual([...SPEC_ORDER]);
    expect(first.every((step) => step.actions.length === 1)).toBe(true);

    system.calls.length = 0;
    const second = await applyGraph({ steps: system.steps(), store, context: desiredAll("r1"), installation, now });
    expect(second.map((step) => step.name)).toEqual([...SPEC_ORDER]);
    expect(second.flatMap((step) => step.actions)).toEqual([]);
    expect(system.callsOf("observe")).toEqual([...SPEC_ORDER]);
    expect(system.callsOf("apply")).toEqual([]);

    const state = await store.load();
    for (const name of SPEC_ORDER) {
      expect(state.steps[name]).toEqual({ result: "unchanged", finishedAt: NOW.toISOString(), inputHash: R1_INPUT_HASH });
    }
  });

  test("a failure in the eighth step keeps the saved state of the first seven", async () => {
    const system = new FakeSystem();
    const store = freshStore();
    let onDiskWhenTheEighthApplied: string[] = [];
    const steps = SPEC_ORDER.map((name) =>
      name === "postgres-provision"
        ? system.step(name, async () => {
            // Read the file as a crash at this point would leave it.
            onDiskWhenTheEighthApplied = Object.keys((await new FileStateStore(store.path).load()).steps);
            throw new Error("postgres-provision broke");
          })
        : system.step(name),
    );

    const error = await rejection(
      applyGraph({ steps, store, context: desiredAll("r1"), installation: installationOf(), now }),
    );
    expect((error as Error).message).toBe("postgres-provision broke");
    expect(onDiskWhenTheEighthApplied).toEqual(SPEC_ORDER.slice(0, 7));
    expect(system.callsOf("observe")).toEqual(SPEC_ORDER.slice(0, 8));

    const state = await store.load();
    for (const name of SPEC_ORDER.slice(0, 7)) {
      expect(state.steps[name]).toEqual({ result: "applied", finishedAt: NOW.toISOString(), inputHash: R1_INPUT_HASH });
    }
    expect(state.steps["postgres-provision"]).toEqual({ result: "failed", finishedAt: NOW.toISOString() });
    for (const name of SPEC_ORDER.slice(8)) {
      expect(state.steps[name]).toBeUndefined();
    }
  });

  test("a run limited to edge-deploy runs only that step", async () => {
    const system = new FakeSystem();
    const store = freshStore();

    const result = await applyGraph({
      steps: system.steps(),
      store,
      context: desiredAll("r1"),
      installation: installationOf(),
      only: ["edge-deploy"],
      now,
    });

    expect(result).toEqual([{ name: "edge-deploy", actions: [{ summary: "set edge-deploy to r1" }] }]);
    expect(system.calls).toEqual(["edge-deploy observe", "edge-deploy plan", "edge-deploy apply"]);
    expect([...system.values.keys()]).toEqual(["edge-deploy"]);
    expect(Object.keys((await store.load()).steps)).toEqual(["edge-deploy"]);
  });

  test("steps run in the documented order whatever order they are registered in", async () => {
    const system = new FakeSystem();
    await applyGraph({
      steps: system.steps([...SPEC_ORDER].reverse()),
      store: freshStore(),
      context: desiredAll("r1"),
      installation: installationOf(),
    });
    expect(system.callsOf("apply")).toEqual([...SPEC_ORDER]);
  });

  test("a run limited to several steps runs them in graph order", async () => {
    const system = new FakeSystem();
    await applyGraph({
      steps: system.steps(),
      store: freshStore(),
      context: desiredAll("r1"),
      installation: installationOf(),
      only: ["base", "images", "base"],
    });
    expect(system.callsOf("observe")).toEqual(["images", "base"]);
  });

  test("a step with an empty plan is not applied and is saved as unchanged", async () => {
    const system = new FakeSystem();
    system.values.set("tls", "r1");
    const store = freshStore();
    const result = await applyGraph({
      steps: system.steps(),
      store,
      context: desiredAll("r1"),
      installation: installationOf(),
      only: ["secrets", "tls", "base"],
      now,
    });
    expect(result.map((step) => [step.name, step.actions.length])).toEqual([
      ["secrets", 1],
      ["tls", 0],
      ["base", 1],
    ]);
    expect(system.callsOf("apply")).toEqual(["secrets", "base"]);
    const state = await store.load();
    expect(state.steps.tls).toEqual({ result: "unchanged", finishedAt: NOW.toISOString(), inputHash: R1_INPUT_HASH });
    expect(state.steps.base?.result).toBe("applied");
  });

  test("a selection naming an unknown step, or a step this build lacks, exits 2 and runs nothing", async () => {
    const system = new FakeSystem();
    const store = freshStore();
    const steps = system.steps(["preflight", "images", "secrets"]);
    const options = { steps, store, context: desiredAll("r1"), installation: installationOf() };

    const unknown = await rejection(applyGraph({ ...options, only: ["images", "frobnicate"] }));
    expect(unknown).toBeInstanceOf(StepSelectionError);
    expect((unknown as StepSelectionError).exitCode).toBe(2);
    expect((unknown as Error).message).toBe("unknown step frobnicate; the steps are preflight, images, secrets");

    const missing = await rejection(applyGraph({ ...options, only: ["verify", "report"] }));
    expect((missing as Error).message).toBe("unknown steps verify, report; the steps are preflight, images, secrets");

    const empty = await rejection(planGraph({ ...options, only: [] }));
    expect(empty).toBeInstanceOf(StepSelectionError);
    expect((empty as Error).message).toBe("no step selected; the steps are preflight, images, secrets");

    expect(system.calls).toEqual([]);
    expect(existsSync(store.path)).toBe(false);
  });

  test("a step registered twice is refused", async () => {
    const system = new FakeSystem();
    const error = await rejection(
      applyGraph({
        steps: [system.step("tls"), system.step("tls")],
        store: freshStore(),
        context: desiredAll("r1"),
        installation: installationOf(),
      }),
    );
    expect((error as Error).message).toBe("step tls is registered twice");
    expect(system.calls).toEqual([]);
  });

  test("changing an immutable field exits 6 before any step observes, in apply and in plan", async () => {
    const system = new FakeSystem();
    const store = freshStore();
    await applyGraph({ steps: system.steps(), store, context: desiredAll("r1"), installation: installationOf() });
    const saved = readFileSync(store.path, "utf8");
    system.calls.length = 0;

    const external = installationOf({ postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } } });
    for (const run of [applyGraph, planGraph]) {
      const error = await rejection(
        run({ steps: system.steps(), store, context: desiredAll("r2"), installation: external }),
      );
      expect(error).toBeInstanceOf(UnsafeChangeError);
      expect((error as UnsafeChangeError).exitCode).toBe(6);
    }
    expect(system.calls).toEqual([]);
    expect(readFileSync(store.path, "utf8")).toBe(saved);
  });

  test("a run that applies nothing leaves the immutable fields open, and the first applied action fixes them", async () => {
    const system = new FakeSystem();
    system.values.set("preflight", "r1");
    const store = freshStore();
    const context = desiredAll("r1");

    await applyGraph({ steps: system.steps(), store, context, installation: installationOf(), only: ["preflight"] });
    expect((await store.load()).installation).toBeUndefined();

    const external = installationOf({ postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } } });
    await applyGraph({ steps: system.steps(), store, context, installation: external, only: ["images"] });
    expect((await store.load()).installation).toEqual(external);
  });

  test("a step that fails after creating an object still saves its ownership record and fixes the immutable fields", async () => {
    const system = new FakeSystem();
    const store = freshStore();
    const installation = installationOf();
    const steps = [
      system.step("postgres-provision", async (run) => {
        run.state.ownership.push({ kind: "postgres-role", name: "libredb_owner", step: "postgres-provision" });
        throw new Error("CREATE DATABASE failed");
      }),
    ];

    const error = await rejection(applyGraph({ steps, store, context: desiredAll("r1"), installation, now }));
    expect((error as Error).message).toBe("CREATE DATABASE failed");

    const state = await store.load();
    expect(state.ownership).toEqual([{ kind: "postgres-role", name: "libredb_owner", step: "postgres-provision" }]);
    expect(state.installation).toEqual(installation);
    expect(state.steps["postgres-provision"]).toEqual({ result: "failed", finishedAt: NOW.toISOString() });
  });

  test("a failed step whose state cannot be saved reports both errors", async () => {
    const system = new FakeSystem();
    const store: StateStore = {
      load: async () => emptyState(),
      save: async () => {
        throw new Error("disk full");
      },
    };
    const steps = [
      system.step("tls", async () => {
        throw new Error("tls broke");
      }),
    ];

    const error = await rejection(applyGraph({ steps, store, context: desiredAll("r1"), installation: installationOf() }));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe("tls failed: tls broke; saving the state then failed too: disk full");
    expect((error as AggregateError).errors.map((cause: Error) => cause.message)).toEqual(["tls broke", "disk full"]);
  });
});

describe("planGraph", () => {
  test("plans every selected step without applying or saving", async () => {
    const system = new FakeSystem();
    const store = freshStore();

    const plans = await planGraph({ steps: system.steps(), store, context: desiredAll("r1"), installation: installationOf() });

    expect(plans.map((plan) => [plan.name, plan.actions.map((action) => action.summary)])).toEqual(
      SPEC_ORDER.map((name) => [name, [`set ${name} to r1`]]),
    );
    expect(system.callsOf("apply")).toEqual([]);
    expect(system.values.size).toBe(0);
    expect(existsSync(store.path)).toBe(false);
  });
});

describe("hashInputs", () => {
  test("is the SHA-256 of the inputs as canonical JSON, whatever the key order", () => {
    // sha256sum of {"a":{"d":2},"b":[1,true,null,"x"]}
    const expected = "a70a72d13227537b512b8a5c3cb76353360758e70fb95a9eace6bd23b895e128";
    expect(hashInputs({ b: [1, true, null, "x"], a: { d: 2, c: undefined } })).toBe(expected);
    expect(hashInputs({ a: { d: 2 }, b: [1, true, null, "x"] })).toBe(expected);
    expect(hashInputs({ value: "r1" })).toBe(R1_INPUT_HASH);
  });

  test("refuses inputs that are not JSON values", () => {
    for (const value of [undefined, () => 1, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(0), new Map(), [undefined]]) {
      expect(() => hashInputs(value)).toThrow(TypeError);
    }
  });
});
