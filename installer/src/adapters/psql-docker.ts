// The SQL runner of Docker mode: psql in a one-shot container of the pinned PostgreSQL image on the network of the
// server. The PG* variables go through a 0600 env file that is deleted as soon as psql exits, except PGPASSWORD, which
// goes through the environment of the docker client, so no password ever touches the disk, and the script goes through
// standard input, so neither a password nor a verifier appears on a command line.
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../log/redact";
import { CA_BUNDLE_MOUNT_PATH } from "../tls/bundle";
import { envFileText, pgEnvironment, PSQL_ARGS, type PsqlLogin, type PsqlResult, type SqlRunner } from "../sql/runner";
import { exec, ExecError, type OutputLine } from "./exec";

export interface DockerPsqlRunnerOptions {
  /** The pinned PostgreSQL image, whose psql runs the scripts. */
  image: string;
  /** The Docker network that reaches the server, such as libredb_data. */
  network: string;
  /** The CA bundle on the host, mounted read-only where PGSSLROOTCERT points. */
  caBundleFile: string;
  /** A directory only its owner can read, which holds each run's env file while psql runs. */
  envDir: string;
  redactor: Redactor;
  log: (line: OutputLine) => void;
  /** Names each container `<namePrefix>-<random>`; the default is libredb-psql. */
  namePrefix?: string;
  /** The docker binary, `docker` on the PATH by default. */
  binary?: string;
  timeoutMs?: number;
  /** psql's arguments, PSQL_ARGS by default; they must read the script from standard input. */
  psqlArgs?: readonly string[];
}

// Exit codes of docker run itself: the daemon refused the container, or its command could not be started.
const DOCKER_RUN_FAILURES = new Set([125, 126, 127]);

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Writes the env file with mode 0600, refusing to replace an existing file. */
function writeEnvFile(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    // The umask can only narrow the mode given to open, so set it exactly.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * The env file of a login without its password, and the environment of the docker client, which hands PGPASSWORD to
 * the container through `--env PGPASSWORD` without a value.
 */
function loginEnvironment(login: PsqlLogin, extra: Readonly<Record<string, string>> = {}) {
  const { PGPASSWORD: password, ...connection } = pgEnvironment(login);
  return { envFileText: envFileText({ ...connection, ...extra }), clientEnv: { ...process.env, PGPASSWORD: password } };
}

/** The arguments of `docker run` that every psql container shares: the network, the login, the CA and the hardening. */
function psqlContainerArgs(
  options: Pick<DockerPsqlRunnerOptions, "network" | "caBundleFile" | "namePrefix">,
  suffix: string,
  envFile: string,
): string[] {
  return [
    "--name",
    `${options.namePrefix ?? "libredb-psql"}-${suffix}`,
    "--network",
    options.network,
    "--env-file",
    envFile,
    "--env",
    "PGPASSWORD",
    "--volume",
    `${options.caBundleFile}:${CA_BUNDLE_MOUNT_PATH}:ro`,
    "--user",
    "postgres",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "psql",
  ];
}

/**
 * Opens psql on the operator's terminal in a one-shot container, for a break-glass session. The
 * terminal passes straight through, so what psql prints is not redacted; the login still goes through a 0600 env file
 * that is deleted when psql exits, and the password through the docker client's environment. Resolves with psql's
 * exit code.
 */
export async function interactivePsql(
  options: Pick<DockerPsqlRunnerOptions, "image" | "network" | "caBundleFile" | "envDir" | "namePrefix" | "binary">,
  login: PsqlLogin,
): Promise<number> {
  const suffix = randomBytes(6).toString("hex");
  const envFile = join(options.envDir, `.psql-${suffix}.env`);
  // The root filesystem is read-only, so psql keeps no history file.
  const environment = loginEnvironment(login, { PSQL_HISTORY: "/dev/null" });
  writeEnvFile(envFile, environment.envFileText);
  try {
    const child = Bun.spawn(
      [
        options.binary ?? "docker",
        "run",
        "--rm",
        "--interactive",
        "--tty",
        ...psqlContainerArgs(options, suffix, envFile),
        options.image,
        "-X",
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: environment.clientEnv },
    );
    return await child.exited;
  } finally {
    rmSync(envFile, { force: true });
  }
}

export class DockerPsqlRunner implements SqlRunner {
  readonly #options: DockerPsqlRunnerOptions;

  constructor(options: DockerPsqlRunnerOptions) {
    this.#options = options;
  }

  async run(login: PsqlLogin, script: string): Promise<PsqlResult> {
    const options = this.#options;
    const suffix = randomBytes(6).toString("hex");
    const envFile = join(options.envDir, `.psql-${suffix}.env`);
    const environment = loginEnvironment(login);
    writeEnvFile(envFile, environment.envFileText);
    try {
      const result = await exec(
        [
          options.binary ?? "docker",
          "run",
          "--rm",
          "--interactive",
          ...psqlContainerArgs(options, suffix, envFile),
          options.image,
          ...(options.psqlArgs ?? PSQL_ARGS),
        ],
        {
          redactor: options.redactor,
          log: options.log,
          stdin: script,
          env: environment.clientEnv,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      );
      // psql exits 0 to 3; anything above means it never ran.
      if (DOCKER_RUN_FAILURES.has(result.exitCode)) throw new ExecError(result);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } finally {
      rmSync(envFile, { force: true });
    }
  }
}
