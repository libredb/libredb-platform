// The configuration of the last apply, kept at /opt/libredb/libredb.yaml for the renewal timer: the
// validated configuration with its --set overrides and every default, and each file reference made absolute, because
// the timer runs in /opt/libredb and not in the directory the operator applied from.
import { isAbsolute, resolve } from "node:path";
import { stringify } from "yaml";
import type { LibreDBInstallation } from "../config/schema";
import type { FileSpec } from "./converge";
import { APPLIED_CONFIG_FILE } from "./layout";

// The configuration holds mappings, lists of scalars such as tls.external.trustedProxies, and scalars.
function withAbsoluteFiles(value: unknown, cwd: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => withAbsoluteFiles(entry, cwd));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key.endsWith("File") && typeof entry === "string" && !isAbsolute(entry)) return [key, resolve(cwd, entry)];
      return [key, withAbsoluteFiles(entry, cwd)];
    }),
  );
}

/** The configuration as YAML, with every `*File` reference resolved against `cwd`, the directory apply ran in. */
export function renderAppliedConfig(config: LibreDBInstallation, cwd: string): string {
  return stringify(withAbsoluteFiles(config, cwd));
}

/** The applied configuration file, readable by root only like the state it leads to. */
export function appliedConfigFile(config: LibreDBInstallation, cwd: string): FileSpec {
  return { path: APPLIED_CONFIG_FILE, content: renderAppliedConfig(config, cwd), mode: 0o600, uid: 0, gid: 0 };
}
