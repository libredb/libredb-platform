import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  renderSystemdUnit,
  renderTlsRenewUnits,
  SYSTEMD_UNIT_FILE,
  TLS_RENEW_SERVICE_FILE,
  TLS_RENEW_TIMER,
  TLS_RENEW_TIMER_FILE,
} from "../../../src/render/systemd";
import { desiredFixture, golden } from "./fixture";

describe("renderSystemdUnit", () => {
  test("renders libredb.service equal to test/golden/libredb.service", () => {
    const unit = renderSystemdUnit(desiredFixture(["docker.systemdUnit=true"]));
    expect(unit).toEqual({ path: SYSTEMD_UNIT_FILE, content: readFileSync(golden("libredb.service"), "utf8") });
    expect(SYSTEMD_UNIT_FILE).toBe("/etc/systemd/system/libredb.service");
  });

  test("renders no unit while docker.systemdUnit is false", () => {
    expect(renderSystemdUnit(desiredFixture())).toBeUndefined();
  });
});

describe("renderTlsRenewUnits", () => {
  test("renders libredb-tls-renew.timer and its service equal to the golden files", () => {
    expect(renderTlsRenewUnits()).toEqual([
      { path: TLS_RENEW_SERVICE_FILE, content: readFileSync(golden("libredb-tls-renew.service"), "utf8") },
      { path: TLS_RENEW_TIMER_FILE, content: readFileSync(golden("libredb-tls-renew.timer"), "utf8") },
    ]);
    expect(TLS_RENEW_SERVICE_FILE).toBe("/etc/systemd/system/libredb-tls-renew.service");
    expect(TLS_RENEW_TIMER_FILE).toBe("/etc/systemd/system/libredb-tls-renew.timer");
    expect(TLS_RENEW_TIMER).toBe("libredb-tls-renew.timer");
  });
});
