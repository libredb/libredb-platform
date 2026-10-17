// Runs the probe scripts of the Platform checks (src/verify/platform.ts) in one-shot containers of the Platform image
// on an app network, with the CA bundle mounted read-only where NODE_EXTRA_CA_CERTS points. The script goes through
// standard input to node, a secret reaches the container only through an env file, and the container runs as the
// image's user with a read-only root filesystem, no capabilities and no privilege gain.
import { randomBytes } from "node:crypto";
import type { Redactor } from "../log/redact";
import { CA_BUNDLE_MOUNT_PATH } from "../tls/bundle";
import type { ProbeRequest, ProbeResult, ProbeRunner } from "../verify/platform";
import { exec, type OutputLine } from "./exec";

export interface DockerProbeRunnerOptions {
  /** The pinned Platform image, whose node runs the scripts as Platform runs its own requests. */
  image: string;
  /** The Docker network that reaches Platform, Keycloak and the edge, such as libredb_edge. */
  network: string;
  /** The CA bundle on the host. */
  caBundleFile: string;
  redactor: Redactor;
  log: (line: OutputLine) => void;
  /** Names each container `<namePrefix>-<random>`; the default is libredb-probe. */
  namePrefix?: string;
  /** The docker binary, `docker` on the PATH by default. */
  binary?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export class DockerProbeRunner implements ProbeRunner {
  readonly #options: DockerProbeRunnerOptions;

  constructor(options: DockerProbeRunnerOptions) {
    this.#options = options;
  }

  async run(request: ProbeRequest): Promise<ProbeResult> {
    const options = this.#options;
    const env = { NODE_EXTRA_CA_CERTS: CA_BUNDLE_MOUNT_PATH, ...request.env };
    const result = await exec(
      [
        options.binary ?? "docker",
        "run",
        "--rm",
        "--interactive",
        "--name",
        `${options.namePrefix ?? "libredb-probe"}-${randomBytes(6).toString("hex")}`,
        "--network",
        options.network,
        ...(request.envFile === undefined ? [] : ["--env-file", request.envFile]),
        ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        "--volume",
        `${options.caBundleFile}:${CA_BUNDLE_MOUNT_PATH}:ro`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "node",
        options.image,
        "--input-type=module",
        "-",
      ],
      {
        redactor: options.redactor,
        log: options.log,
        stdin: request.script,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
}
