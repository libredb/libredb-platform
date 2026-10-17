// Reads libredb.yaml, applies the --set overrides (file first, overrides last) and validates the result.
import { readFileSync } from "node:fs";
import { parse, parseAllDocuments } from "yaml";
import { ConfigError, formatPath, parseInstallation, type LibreDBInstallation } from "./schema";

export interface LoadOptions {
  file: string;
  sets?: readonly string[];
}

export interface SetOverride {
  path: string[];
  value: string | number | boolean | null;
}

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlErrorMessage(error: unknown): string {
  return `invalid YAML: ${(error as Error).message.split("\n")[0]}`;
}

/** Reads one YAML document that must be a mapping. */
export function readConfigDocument(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError([`cannot read ${file}: ${(error as Error).message}`]);
  }
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (documents.length > 1) {
    throw new ConfigError([`${file}: the configuration must be exactly one YAML document`]);
  }
  const [document] = documents;
  const error = document?.errors[0];
  if (error !== undefined) throw new ConfigError([yamlErrorMessage(error)]);
  const value: unknown = document?.toJS();
  if (!isMapping(value)) throw new ConfigError([`${formatPath([])}: the configuration must be a YAML mapping`]);
  return value;
}

/** Parses `path=value`, where path is dotted and value is a YAML scalar. */
export function parseSet(expression: string): SetOverride {
  const equals = expression.indexOf("=");
  if (equals < 0) throw new ConfigError([`--set ${expression}: expected path=value`]);
  const path = expression.slice(0, equals).split(".");
  if (path.some((segment) => segment === "")) {
    throw new ConfigError([`--set ${expression}: the path has an empty segment`]);
  }
  const reserved = path.find((segment) => RESERVED_KEYS.has(segment));
  if (reserved !== undefined) {
    throw new ConfigError([`--set ${expression}: the path uses the reserved key ${reserved}`]);
  }
  let value: unknown;
  try {
    value = parse(expression.slice(equals + 1));
  } catch (error) {
    throw new ConfigError([`--set ${expression}: ${yamlErrorMessage(error)}`]);
  }
  if (typeof value === "object" && value !== null) {
    throw new ConfigError([`--set ${expression}: the value must be a YAML scalar`]);
  }
  return { path, value: value as SetOverride["value"] };
}

/** Returns a copy of the document with each override applied in order, so the last one wins. */
export function applyOverrides(document: Record<string, unknown>, sets: readonly string[]): Record<string, unknown> {
  const result = structuredClone(document);
  for (const expression of sets) {
    const { path, value } = parseSet(expression);
    let target = result;
    for (const [index, segment] of path.slice(0, -1).entries()) {
      const next = target[segment];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        target[segment] = created;
        target = created;
      } else if (isMapping(next)) {
        target = next;
      } else {
        throw new ConfigError([`--set ${expression}: ${path.slice(0, index + 1).join(".")} is not a mapping`]);
      }
    }
    target[path[path.length - 1] as string] = value;
  }
  return result;
}

/** Loads, overrides and validates a configuration. Throws ConfigError for any problem. */
export function loadConfig(options: LoadOptions): LibreDBInstallation {
  return parseInstallation(applyOverrides(readConfigDocument(options.file), options.sets ?? []));
}
