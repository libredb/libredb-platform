// The seal key rotation, driven by bridge.sealKeys of the configuration. issueNew adds one live key to
// Studio's keyring, activeKid selects the key whose public half Platform receives, and retire removes kids from the
// live keyring while the secret store keeps them in escrow. Every step is additive or refused: a rollback cannot
// restore an old secret value, so apply refuses with exit 6 what would leave a credential unopenable.
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import { quoteLiteral } from "../sql/quote";
import { parseResult, parseResults, resultQuery } from "../sql/runner";
import { MAX_KEYRING_KEYS } from "./keyring";
import type { SealKeyState } from "./store";

/** A seal key as the rotation plans with it: its kid and state, never a key. */
export type SealKeyView = { readonly kid: string; readonly state: SealKeyState };

/** `bridge.sealKeys` of the configuration. */
export interface SealKeysConfig {
  issueNew: boolean;
  activeKid?: string;
  retire: readonly string[];
}

/** A rotation step apply refuses, because it would leave an envelope or Platform without a key. */
export class SealRotationError extends Error {
  readonly exitCode = ExitCode.UnsafeChangeRefused;

  constructor(message: string) {
    super(message);
    this.name = "SealRotationError";
  }
}

/** An envelope in bridge.connections_v1, named by the kid that sealed it and its connection. */
export interface EnvelopeUse {
  kid: string;
  connectionId: string;
  name: string;
}

export type SealRotationAction =
  | { kind: "issue-seal-key"; summary: string }
  | { kind: "delete-seal-canary"; kid: string; summary: string }
  | { kind: "retire-seal-key"; kid: string; summary: string };

/**
 * The seal key whose public half Platform receives as BRIDGE_SEAL_PUBLIC_KEY: the live key activeKid names, or else
 * the oldest live one, so a key issued later reaches Studio's keyring before Platform seals with it.
 */
export function activeSealKey<K extends SealKeyView>(sealKeys: readonly K[], activeKid: string | undefined): K {
  if (activeKid !== undefined) {
    const named = sealKeys.find((key) => key.kid === activeKid);
    if (named === undefined || named.state !== "live") {
      const found = named === undefined ? "names no seal key the secret store issued" : "names a retired seal key";
      throw new SealRotationError(
        `bridge.sealKeys.activeKid ${activeKid} ${found}, so Platform would seal to a key Studio cannot open; ` +
          `name one of the live kids ${liveKids(sealKeys).join(", ")}`,
      );
    }
    return named;
  }
  const oldest = sealKeys.find((key) => key.state === "live");
  if (oldest === undefined) {
    throw new Error(
      "the secret store holds no live seal key, so BRIDGE_SEAL_PUBLIC_KEY has no value; apply the secrets step first",
    );
  }
  return oldest;
}

function liveKids(sealKeys: readonly SealKeyView[]): string[] {
  return sealKeys.filter((key) => key.state === "live").map((key) => key.kid);
}

/**
 * The live kids that this apply retires, the ones whose envelopes apply must look for in bridge.connections_v1.
 * A kid that is already retired stays retired and needs nothing. Refuses with exit 6 to retire a kid the store never
 * issued, or the active kid, whose public key Platform seals with.
 */
export function sealKidsToRetire(sealKeys: readonly SealKeyView[], config: SealKeysConfig): string[] {
  if (config.retire.length === 0) return [];
  const unknown = config.retire.filter((kid) => !sealKeys.some((key) => key.kid === kid));
  if (unknown.length > 0) {
    throw new SealRotationError(`bridge.sealKeys.retire: the secret store issued no seal key ${unknown.join(", ")}`);
  }
  const active = activeSealKey(sealKeys, config.activeKid);
  const kids: string[] = [];
  for (const kid of config.retire) {
    const key = sealKeys.find((candidate) => candidate.kid === kid) as SealKeyView;
    if (kid === active.kid) {
      throw new SealRotationError(
        `bridge.sealKeys.retire: ${kid} is the active kid, whose public key Platform seals with; ` +
          "switch bridge.sealKeys.activeKid to another live key and re-enter the credentials first",
      );
    }
    if (key.state === "live") kids.push(kid);
  }
  return kids;
}

/**
 * The actions of one apply: retire each live kid of `retire` after deleting its canary row, then issue a new key when
 * issueNew is set and the active key is the newest live key, so a second apply with the same configuration issues
 * none. `envelopes` are the uses of the kids sealKidsToRetire named.
 */
export function planSealRotation(
  sealKeys: readonly SealKeyView[],
  config: SealKeysConfig,
  envelopes: readonly EnvelopeUse[],
): SealRotationAction[] {
  const actions: SealRotationAction[] = [];
  const retiring = sealKidsToRetire(sealKeys, config);
  for (const kid of retiring) {
    const uses = envelopes.filter((use) => use.kid === kid);
    if (uses.length > 0) {
      throw new SealRotationError(
        `bridge.sealKeys.retire: kid ${kid} still seals credentials of ${uses.length} connection` +
          `${uses.length === 1 ? "" : "s"} in bridge.connections_v1: ` +
          `${uses.map((use) => `${use.name} (${use.connectionId})`).join(", ")}; ` +
          "re-enter their credentials in Platform first, so they are sealed to the active kid",
      );
    }
    actions.push(
      {
        kind: "delete-seal-canary",
        kid,
        summary: `delete the seal canary of kid ${kid} from platform.seal_canary as libredb_platform`,
      },
      {
        kind: "retire-seal-key",
        kid,
        summary: `retire seal key ${kid}: remove it from the Studio keyring and keep it in the secret store`,
      },
    );
  }
  if (config.issueNew && issueDue(sealKeys, config.activeKid)) {
    const live = liveKids(sealKeys).filter((kid) => !retiring.includes(kid)).length;
    if (live >= MAX_KEYRING_KEYS) {
      throw new SealRotationError(
        `bridge.sealKeys.issueNew: the live keyring already holds ${live} kids, the limit of ${MAX_KEYRING_KEYS} ` +
          "that Studio accepts; retire a kid with bridge.sealKeys.retire first",
      );
    }
    actions.push({ kind: "issue-seal-key", summary: "issue a new seal key for the Studio keyring" });
  }
  return actions;
}

/** Whether issueNew issues a key: the store issued none yet, or the active key is the newest live key. */
function issueDue(sealKeys: readonly SealKeyView[], activeKid: string | undefined): boolean {
  if (sealKeys.length === 0) return true;
  const newest = sealKeys.filter((key) => key.state === "live").at(-1);
  return newest !== undefined && newest.kid === activeSealKey(sealKeys, activeKid).kid;
}

const ENVELOPE_USES = "envelope-uses";

/**
 * The query, as libredb_platform, that lists the connections whose read or write envelope in bridge.connections_v1
 * names one of the kids. An envelope is `lsb1.<kid>.<...>`, so the kid is its second dot-separated field.
 */
export function envelopeUsesScript(kids: readonly string[]): string {
  const list = kids.map(quoteLiteral).join(", ");
  const uses =
    "SELECT connection_id, name, split_part(read_secret, '.', 2) AS kid FROM bridge.connections_v1 " +
    "UNION SELECT connection_id, name, split_part(write_secret, '.', 2) FROM bridge.connections_v1 " +
    "WHERE write_secret IS NOT NULL";
  const json =
    "SELECT coalesce(jsonb_agg(jsonb_build_object('kid', e.kid, 'connectionId', e.connection_id::text, 'name', e.name) " +
    `ORDER BY e.kid, e.name), '[]'::jsonb) FROM (${uses}) e WHERE e.kid IN (${list})`;
  return `${resultQuery(ENVELOPE_USES, `(${json})`)}\n`;
}

const envelopeUses = z.array(z.object({ kid: z.string(), connectionId: z.string(), name: z.string() }).strict());

export function parseEnvelopeUses(stdout: string): EnvelopeUse[] {
  return parseResult(envelopeUses, parseResults(stdout).get(ENVELOPE_USES), "envelope uses");
}

/**
 * Deletes a retired kid's canary as libredb_platform. Platform only inserts canaries, so the row would otherwise make
 * every heartbeat report UNKNOWN_KID for that kid for good.
 */
export function deleteCanaryScript(kid: string): string {
  return `DELETE FROM platform.seal_canary WHERE kid = ${quoteLiteral(kid)};\n`;
}
