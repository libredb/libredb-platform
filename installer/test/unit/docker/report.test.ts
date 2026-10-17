import { describe, expect, test } from "bun:test";
import { changeCount, formatPlan, formatStatus, NO_CHANGES } from "../../../src/docker/report";
import { emptyState } from "../../../src/state/store";

describe("formatPlan", () => {
  test("prints No changes when no step planned an action", () => {
    expect(formatPlan([{ name: "preflight", actions: [] }, { name: "edge-deploy", actions: [] }])).toBe(`${NO_CHANGES}\n`);
  });

  test("prints one block per step with changes and the total", () => {
    const plans = [
      { name: "preflight" as const, actions: [] },
      { name: "images" as const, actions: [{ summary: "pull a" }, { summary: "pull b" }] },
      { name: "edge-deploy" as const, actions: [{ summary: "start edge" }] },
    ];
    expect(changeCount(plans)).toBe(3);
    expect(formatPlan(plans)).toBe(
      "images:\n  - pull a\n  - pull b\nedge-deploy:\n  - start edge\n3 changes in 2 steps\n",
    );
    expect(formatPlan([{ name: "images", actions: [{ summary: "pull a" }] }])).toBe(
      "images:\n  - pull a\n1 change in 1 step\n",
    );
  });
});

describe("formatStatus", () => {
  const state = emptyState();
  state.steps.preflight = { result: "unchanged", finishedAt: "2026-10-15T09:00:00.000Z", inputHash: "a".repeat(64) };
  state.steps["edge-deploy"] = { result: "failed", finishedAt: "2026-10-15T09:01:00.000Z" };

  test("prints each step's last result, the lock holder and every container's health", () => {
    const text = formatStatus({
      steps: ["preflight", "edge-deploy", "postgres-deploy"],
      state,
      lock: { text: "", owner: { pid: 42, host: "db1", since: "2026-10-15T09:00:00.000Z" } },
      containers: [
        { id: "1", name: "libredb-edge-1", service: "edge", state: "running", health: "healthy", image: "caddy" },
        { id: "2", name: "libredb-postgres-1", service: "postgres", state: "exited", health: "", image: "postgres" },
      ],
      certificates: [
        { name: "internal CA", notAfter: new Date("2036-10-15T12:00:00.000Z") },
        { name: "studio.libredb.test", notAfter: new Date("2026-11-13T13:00:00.000Z") },
      ],
      now: new Date("2026-10-15T12:00:00.000Z"),
    });
    expect(text).toBe(
      [
        "Steps:",
        "  preflight        unchanged  2026-10-15T09:00:00.000Z",
        "  edge-deploy      failed     2026-10-15T09:01:00.000Z",
        "  postgres-deploy  never run",
        "Lock: held by pid 42 on db1 since 2026-10-15T09:00:00.000Z",
        "Containers:",
        "  edge      running  healthy",
        "  postgres  exited   no healthcheck",
        "Certificates:",
        "  internal CA          expires 2036-10-15T12:00:00.000Z  3653 days left",
        "  studio.libredb.test  expires 2026-11-13T13:00:00.000Z  29 days left",
        "",
      ].join("\n"),
    );
  });

  test("names a free lock, a lock without a holder, and a project without containers or compose file", () => {
    const free = formatStatus({ steps: [], state, lock: undefined, containers: [], certificates: [], now: new Date() });
    expect(free).toContain("Lock: free\nContainers: none\n");
    expect(free).toContain("Certificates: none, because the tls step has not issued any yet\n");
    const unnamed = formatStatus({
      steps: [],
      state,
      lock: { text: "x", owner: undefined },
      containers: undefined,
      certificates: [],
      now: new Date(),
    });
    expect(unnamed).toContain("Lock: present, but it does not name the run that holds it");
    expect(unnamed).toContain("Containers: none, because no compose file was rendered yet");
  });
});
