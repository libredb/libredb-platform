// Renders /etc/systemd/system/libredb.service, which brings the Compose project up at boot when
// docker.systemdUnit is true, and the yearly certificate renewal timer with its service.
import { APPLIED_CONFIG_FILE, INSTALLER_BINARY } from "../docker/layout";
import type { DesiredInstallation } from "../model/desired";
import { COMPOSE_FILE, COMPOSE_PROJECT, INSTALL_ROOT } from "./compose";

export const SYSTEMD_UNIT_FILE = "/etc/systemd/system/libredb.service";

export interface RenderedFile {
  path: string;
  content: string;
}

/** Returns the unit, or undefined when the configuration does not ask for one. */
export function renderSystemdUnit(desired: DesiredInstallation): RenderedFile | undefined {
  if (!desired.systemdUnit) return undefined;
  const content = [
    "[Unit]",
    `Description=LibreDB (Docker Compose project ${COMPOSE_PROJECT})`,
    "Requires=docker.service",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `WorkingDirectory=${INSTALL_ROOT}`,
    `ExecStart=/usr/bin/docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} up -d`,
    "TimeoutStartSec=0",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  return { path: SYSTEMD_UNIT_FILE, content };
}

export const TLS_RENEW_SERVICE = "libredb-tls-renew.service";
export const TLS_RENEW_TIMER = "libredb-tls-renew.timer";
export const TLS_RENEW_SERVICE_FILE = `/etc/systemd/system/${TLS_RENEW_SERVICE}`;
export const TLS_RENEW_TIMER_FILE = `/etc/systemd/system/${TLS_RENEW_TIMER}`;

/**
 * The renewal timer and the service it starts once a year, also after a missed run: apply --renew-certificates with
 * the installer binary and the configuration that the last apply copied under /opt/libredb. It re-issues every leaf
 * from the kept internal CA.
 */
export function renderTlsRenewUnits(): RenderedFile[] {
  const service = [
    "[Unit]",
    "Description=LibreDB certificate renewal: libredb-installer apply --renew-certificates",
    "Requires=docker.service",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${INSTALL_ROOT}`,
    `ExecStart=${INSTALLER_BINARY} apply --renew-certificates --yes -c ${APPLIED_CONFIG_FILE}`,
    "TimeoutStartSec=0",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Renew the LibreDB certificates once a year",
    "",
    "[Timer]",
    "OnCalendar=yearly",
    "Persistent=true",
    `Unit=${TLS_RENEW_SERVICE}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return [
    { path: TLS_RENEW_SERVICE_FILE, content: service },
    { path: TLS_RENEW_TIMER_FILE, content: timer },
  ];
}
