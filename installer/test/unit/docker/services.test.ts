import { describe, expect, test } from "bun:test";
import type { ComposeContainer } from "../../../src/adapters/docker";
import { planReloadableService, planService, type ServiceAction } from "../../../src/docker/services";

const container = (state: string, health: string): ComposeContainer => ({
  id: "abc",
  name: "libredb-edge-1",
  service: "edge",
  state,
  health,
  image: "caddy",
});

const base = { service: "edge", recordedInputHash: "h1", inputHash: "h1" };

describe("planService", () => {
  test("starts a service without a container", () => {
    expect(planService({ ...base, container: undefined })).toEqual([
      { kind: "service", service: "edge", recreate: false, summary: "start edge" },
    ]);
  });

  test("plans nothing for a running healthy container with unchanged inputs", () => {
    expect(planService({ ...base, container: container("running", "healthy") })).toEqual([]);
  });

  test("recreates a container whose inputs changed or were never recorded", () => {
    const recreate: ServiceAction[] = [
      { kind: "service", service: "edge", recreate: true, summary: "recreate edge with its changed configuration" },
    ];
    expect(planService({ ...base, inputHash: "h2", container: container("running", "healthy") })).toEqual(recreate);
    expect(planService({ ...base, recordedInputHash: undefined, container: container("running", "healthy") })).toEqual(
      recreate,
    );
  });

  test("starts a stopped or unhealthy container", () => {
    expect(planService({ ...base, container: container("exited", "") })[0]?.summary).toBe(
      "start edge, which is exited with no health status",
    );
    expect(planService({ ...base, container: container("running", "unhealthy") })[0]?.summary).toBe(
      "start edge, which is running with unhealthy",
    );
  });
});

describe("planReloadableService", () => {
  const postgres = { service: "postgres", recordedInputHash: "h1", inputHash: "h2" };

  test("a running server whose inputs changed is brought up without a forced recreate and then reloaded", () => {
    expect(planReloadableService({ ...postgres, container: container("running", "healthy") }, "reload postgres")).toEqual([
      {
        kind: "service",
        service: "postgres",
        recreate: false,
        summary: "bring postgres up to its definition, which recreates it only when the definition itself changed",
      },
      { kind: "reload", summary: "reload postgres" },
    ]);
  });

  test("a missing or unchanged container is planned as planService plans it", () => {
    expect(planReloadableService({ ...postgres, container: undefined }, "reload postgres")).toEqual(
      planService({ ...postgres, container: undefined }),
    );
    const unchanged = { ...postgres, inputHash: "h1", container: container("running", "healthy") };
    expect(planReloadableService(unchanged, "reload postgres")).toEqual([]);
  });
});
