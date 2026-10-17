// Step 5 of the Docker graph: the directories under /opt/libredb with their modes, the project's networks,
// the world-readable CA bundle and, with docker.systemdUnit, the libredb.service unit that starts the project at boot.
// It also keeps a copy of the installer binary and the applied configuration under /opt/libredb, which the yearly
// certificate renewal timer runs, and installs that timer whenever the host runs systemd, or else warns that nothing
// renews the certificates.
import { readFileSync } from "node:fs";
import { exec } from "../adapters/exec";
import {
  applyCopy,
  applyDirectory,
  applyFile,
  observeBinary,
  observePath,
  readOptionalFile,
  type ObservedBinary,
} from "../adapters/host-fs";
import { appliedConfigFile } from "../docker/applied-config";
import {
  planDirectory,
  planFile,
  type DirectoryAction,
  type FileAction,
  type FileSpec,
  type ObservedPath,
} from "../docker/converge";
import { APPLIED_CONFIG_FILE, BASE_DIRECTORIES, CA_BUNDLE_FILE, INSTALLER_BINARY, INTERNAL_CA_FILES } from "../docker/layout";
import { composeNetworks, planNetworks, type NetworkAction, type ObservedNetwork } from "../docker/project";
import type { Action, Step } from "../engine/step";
import {
  renderSystemdUnit,
  renderTlsRenewUnits,
  SYSTEMD_UNIT_FILE,
  TLS_RENEW_SERVICE_FILE,
  TLS_RENEW_TIMER,
  TLS_RENEW_TIMER_FILE,
} from "../render/systemd";
import { buildCaBundle, caBundleFiles, postgresCaBundleFile } from "../tls/bundle";
import { renderedCompose } from "./deploy";
import { recordOwnership, type DockerContext } from "./docker-context";

const SYSTEMD_UNIT = "libredb.service";
const QUICK_MS = 60_000;
const UNIT_FILES = new Set([SYSTEMD_UNIT_FILE, TLS_RENEW_SERVICE_FILE, TLS_RENEW_TIMER_FILE]);

/** The directory that exists while systemd is the init system, as sd_booted(3) checks it. */
const SYSTEMD_RUNTIME_DIR = "/run/systemd/system";

/** What plan and apply warn on a host without systemd, which runs no renewal timer. */
export const NO_RENEWAL_TIMER =
  `no ${TLS_RENEW_TIMER} was installed, because the host does not run systemd (${SYSTEMD_RUNTIME_DIR} does not exist), ` +
  `so nothing renews the certificates automatically: run '${INSTALLER_BINARY} apply --renew-certificates --yes -c ` +
  `${APPLIED_CONFIG_FILE}' once a year, as the timer would`;

/** A compiled installer runs its code from Bun's embedded file system; a source run is bun itself. */
const COMPILED_PREFIX = "/$bunfs/";

type BaseAction =
  | DirectoryAction
  | NetworkAction
  | FileAction
  | (Action & { kind: "bundle-pending" })
  | (Action & { kind: "systemd-enable" })
  | (Action & { kind: "installer-binary"; source: string })
  | (Action & { kind: "installer-binary-unavailable"; reason: string })
  | (Action & { kind: "timer-enable" });

/** The running installer binary, or why there is none to copy. */
type InstallerSource = { path: string; sha256: string } | { unavailable: string };

interface RenewalObservation {
  source: InstallerSource;
  /** The copy under /opt/libredb/bin, or undefined when it does not exist. */
  copy: ObservedBinary | undefined;
  appliedConfig: { spec: FileSpec; observed: ObservedPath | undefined };
  /** The timer and its service, or undefined when the host does not run systemd. */
  timer: { units: { spec: FileSpec; observed: ObservedPath | undefined }[]; enabled: boolean; active: boolean } | undefined;
}

interface BaseObservation {
  directories: (ObservedPath | undefined)[];
  networks: ObservedNetwork[];
  /** The bundle as rendered from the internal CA, or undefined while the TLS step has not created the CA. */
  bundle: FileSpec | undefined;
  bundleObserved: ObservedPath | undefined;
  systemd: { unit: FileSpec; observed: ObservedPath | undefined; enabled: boolean } | undefined;
  renewal: RenewalObservation;
}

function installerSource(): InstallerSource {
  if (!Bun.main.startsWith(COMPILED_PREFIX)) {
    return {
      unavailable:
        `the installer runs from source (${Bun.main}), so there is no binary for the renewal timer to run; ` +
        "apply with the compiled libredb-installer binary",
    };
  }
  const running = observeBinary(process.execPath);
  if (running === undefined) throw new Error(`the running installer binary ${process.execPath} does not exist`);
  return { path: process.execPath, sha256: running.sha256 };
}

async function observeRenewal(context: DockerContext): Promise<RenewalObservation> {
  const config = appliedConfigFile(context.config, process.cwd());
  let timer: RenewalObservation["timer"];
  if (observePath(SYSTEMD_RUNTIME_DIR)?.kind === "directory") {
    const units = renderTlsRenewUnits().map((unit) => ({
      spec: { ...unit, mode: 0o644, uid: 0, gid: 0 },
      observed: observePath(unit.path),
    }));
    const enabled = (await systemctl(context, ["is-enabled", TLS_RENEW_TIMER], false)).stdout.trim() === "enabled";
    const active = (await systemctl(context, ["is-active", TLS_RENEW_TIMER], false)).stdout.trim() === "active";
    timer = { units, enabled, active };
  }
  return {
    source: installerSource(),
    copy: observeBinary(INSTALLER_BINARY),
    appliedConfig: { spec: config, observed: observePath(config.path) },
    timer,
  };
}

const BINARY_MODE = 0o755;

function planRenewal(observed: RenewalObservation): BaseAction[] {
  const actions: BaseAction[] = [];
  const { source, copy } = observed;
  if ("unavailable" in source) {
    actions.push({
      kind: "installer-binary-unavailable",
      reason: source.unavailable,
      summary: `install ${INSTALLER_BINARY} for the certificate renewal timer`,
    });
  } else if (copy === undefined) {
    actions.push({ kind: "installer-binary", source: source.path, summary: `install ${INSTALLER_BINARY}` });
  } else if (copy.sha256 !== source.sha256 || copy.mode !== BINARY_MODE || copy.uid !== 0 || copy.gid !== 0) {
    actions.push({ kind: "installer-binary", source: source.path, summary: `update ${INSTALLER_BINARY} to the running installer` });
  }
  actions.push(...planFile(observed.appliedConfig.spec, observed.appliedConfig.observed));
  if (observed.timer !== undefined) {
    for (const unit of observed.timer.units) actions.push(...planFile(unit.spec, unit.observed));
    if (!observed.timer.enabled || !observed.timer.active) {
      actions.push({ kind: "timer-enable", summary: `enable and start ${TLS_RENEW_TIMER}` });
    }
  }
  return actions;
}

function renderBundle(context: DockerContext): FileSpec | undefined {
  const caPem = readOptionalFile(INTERNAL_CA_FILES.certificate);
  if (caPem === undefined) return undefined;
  const read = (source: string) => ({ source, pem: readFileSync(source, "utf8") });
  // The CA of an external PostgreSQL server leads the bundle, because Prisma in the migrate job trusts only the first.
  const postgres = postgresCaBundleFile(context.config);
  const inputs = caBundleFiles(context.config).filter((source) => source !== postgres).map(read);
  const leading = postgres === undefined ? [] : [read(postgres)];
  return { path: CA_BUNDLE_FILE, content: buildCaBundle(caPem, inputs, leading), mode: 0o644, uid: 0, gid: 0 };
}

function systemctl(context: DockerContext, args: string[], check: boolean) {
  return exec(["systemctl", ...args], { redactor: context.redactor, log: context.log, timeoutMs: QUICK_MS, check });
}

export const baseDockerStep: Step<DockerContext, BaseObservation, BaseAction> = {
  name: "base",
  inputs: (context) => ({
    directories: BASE_DIRECTORIES,
    networks: composeNetworks(renderedCompose(context.desired)),
    caBundleFiles: caBundleFiles(context.config),
    systemdUnit: context.desired.systemdUnit,
  }),
  async observe({ context }) {
    const networks: ObservedNetwork[] = [];
    for (const network of composeNetworks(renderedCompose(context.desired))) {
      const found = await context.docker.networkInspect(network.name);
      if (found !== undefined) networks.push(found);
    }
    const unit = renderSystemdUnit(context.desired);
    let systemd: BaseObservation["systemd"];
    if (unit !== undefined) {
      const enabled = (await systemctl(context, ["is-enabled", SYSTEMD_UNIT], false)).stdout.trim() === "enabled";
      systemd = { unit: { ...unit, mode: 0o644, uid: 0, gid: 0 }, observed: observePath(unit.path), enabled };
    }
    return {
      directories: BASE_DIRECTORIES.map((directory) => observePath(directory.path)),
      networks,
      bundle: renderBundle(context),
      bundleObserved: observePath(CA_BUNDLE_FILE),
      systemd,
      renewal: await observeRenewal(context),
    };
  },
  plan(observed, { context }) {
    const actions: BaseAction[] = BASE_DIRECTORIES.flatMap((directory, index) =>
      planDirectory(directory, observed.directories[index]),
    );
    actions.push(...planNetworks(composeNetworks(renderedCompose(context.desired)), observed.networks));
    if (observed.bundle === undefined) {
      actions.push({ kind: "bundle-pending", summary: `create ${CA_BUNDLE_FILE} from the internal CA` });
    } else {
      actions.push(...planFile(observed.bundle, observed.bundleObserved));
    }
    if (observed.systemd !== undefined) {
      actions.push(...planFile(observed.systemd.unit, observed.systemd.observed));
      if (!observed.systemd.enabled) actions.push({ kind: "systemd-enable", summary: `enable ${SYSTEMD_UNIT}` });
    }
    actions.push(...planRenewal(observed.renewal));
    if (observed.renewal.timer === undefined) context.warn(NO_RENEWAL_TIMER);
    return actions;
  },
  async apply(actions, { context, state }) {
    for (const action of actions) {
      switch (action.kind) {
        case "directory":
          applyDirectory(action.directory);
          break;
        case "network":
          await context.docker.networkCreate(action.network, action.labels);
          recordOwnership(state, { kind: "docker-network", name: action.network.name, step: "base" });
          break;
        case "file":
          applyFile(action.file);
          if (UNIT_FILES.has(action.file.path)) {
            const name = action.file.path.slice(action.file.path.lastIndexOf("/") + 1);
            recordOwnership(state, { kind: "systemd-unit", name, step: "base" });
            await systemctl(context, ["daemon-reload"], true);
          }
          break;
        case "bundle-pending":
          throw new Error(`cannot create ${CA_BUNDLE_FILE}: the internal CA does not exist, so apply the tls step first`);
        case "systemd-enable":
          await systemctl(context, ["enable", SYSTEMD_UNIT], true);
          break;
        case "installer-binary":
          applyCopy(action.source, { path: INSTALLER_BINARY, mode: BINARY_MODE, uid: 0, gid: 0 });
          break;
        case "installer-binary-unavailable":
          throw new Error(`cannot ${action.summary}: ${action.reason}`);
        case "timer-enable":
          await systemctl(context, ["enable", "--now", TLS_RENEW_TIMER], true);
          break;
      }
    }
  },
};
