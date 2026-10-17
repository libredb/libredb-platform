// Step 3 of the Docker graph: generates each missing secret once in the store under /opt/libredb/secrets,
// records its fingerprint in the state, and issues the first seal key. A present secret is never regenerated. With
// keycloak.external.provisioning manual the secrets of libredb-studio and libredb-platform come from the site through
// their references instead, and the step stores each supplied value that the store does not hold yet.
// It also runs the seal key rotation of bridge.sealKeys: it retires each live kid of `retire` after checking
// that no envelope in bridge.connections_v1 still uses it and deleting its canary row as libredb_platform, and issues
// a new key for issueNew. The studio-deploy step then renders the keyring from the live keys.
import { readOptionalFile } from "../adapters/host-fs";
import { readSecretReference, type SecretLookup } from "../config/secret-ref";
import {
  dockerSecretNames,
  planSealKey,
  planSecrets,
  planSiteSecrets,
  siteSecretReferences,
  type SecretAction,
  type SiteSecretLookup,
} from "../docker/secrets";
import type { Step } from "../engine/step";
import {
  deleteCanaryScript,
  envelopeUsesScript,
  parseEnvelopeUses,
  planSealRotation,
  sealKidsToRetire,
  type EnvelopeUse,
  type SealRotationAction,
} from "../secrets/seal-rotation";
import { secretFingerprint, type SecretFingerprints } from "../secrets/store";
import { ROLE_SPECS } from "../sql/provision";
import { runScript } from "../sql/runner";
import type { DockerContext } from "./docker-context";
import { platformLogin, postgresServer, secretValue } from "./platform-deploy";
import { postgresRunner } from "./postgres-provision";

/** Reads the site's secrets from their references and registers every supplied value with the redactor. */
function siteSecretValues(context: DockerContext): { name: string; path: string; lookup: SecretLookup }[] {
  return siteSecretReferences(context.config).map(({ name, reference }) => {
    const lookup = readSecretReference(reference, { env: process.env, readFile: readOptionalFile });
    if ("value" in lookup) context.redactor.register(lookup.value);
    return { name, path: reference.path, lookup };
  });
}

function siteLookups(context: DockerContext): SiteSecretLookup[] {
  return siteSecretValues(context).map(({ name, path, lookup }) => ({
    name,
    path,
    supplied: "value" in lookup ? { fingerprint: secretFingerprint(lookup.value) } : { missing: lookup.missing },
  }));
}

interface SecretsObservation extends SecretFingerprints {
  /** The envelopes in bridge.connections_v1 of the live kids this apply retires; read only when it retires one. */
  envelopes: EnvelopeUse[];
}

type SecretsAction = SecretAction | SealRotationAction;

/** Runs a script as libredb_platform, as Platform's runtime and `db-shell --as platform` log in. */
async function platformSql(context: DockerContext, script: string): Promise<string> {
  const login = platformLogin(postgresServer(context), await secretValue(context, ROLE_SPECS.platform.secret));
  return (await runScript(postgresRunner(context), login, script)).stdout;
}

export const secretsStep: Step<DockerContext, SecretsObservation, SecretsAction> = {
  name: "secrets",
  inputs: ({ config }) => {
    const supplied = siteSecretReferences(config).map((secret) => secret.name);
    // Named only when the site supplies secrets, so the inputs of every other install keep the hash they had.
    return {
      names: dockerSecretNames(config),
      sealKeys: config.bridge.sealKeys,
      ...(supplied.length > 0 ? { supplied } : {}),
    };
  },
  async observe({ context }) {
    const stored = await context.secrets.fingerprints();
    const retiring = sealKidsToRetire(stored.sealKeys, context.config.bridge.sealKeys);
    const envelopes =
      retiring.length === 0 ? [] : parseEnvelopeUses(await platformSql(context, envelopeUsesScript(retiring)));
    return { ...stored, envelopes };
  },
  plan(stored, { context, state }) {
    const site = planSiteSecrets(siteLookups(context), stored.values, state.secrets);
    for (const warning of site.warnings) context.warn(warning);
    return [
      ...planSecrets(dockerSecretNames(context.config), stored.values, state.secrets),
      ...site.actions,
      ...planSealKey(stored.sealKeys),
      ...planSealRotation(stored.sealKeys, context.config.bridge.sealKeys, stored.envelopes),
    ];
  },
  async apply(actions, { context, state }) {
    const names = dockerSecretNames(context.config);
    await context.secrets.ensure(names);
    for (const { name, lookup } of siteSecretValues(context)) {
      if (!actions.some((action) => action.kind === "store" && action.name === name)) continue;
      if (!("value" in lookup)) throw new Error(`cannot store secret ${name}: ${lookup.missing}`);
      await context.secrets.put(name, lookup.value);
    }
    if (actions.some((action) => action.kind === "seal-key")) await context.secrets.ensureSealKey();
    const stored = (await context.secrets.fingerprints()).values;
    for (const name of [...names, ...siteSecretReferences(context.config).map((secret) => secret.name)]) {
      const fingerprint = stored[name];
      if (fingerprint === undefined) throw new Error(`the secret store did not keep secret ${name}`);
      state.secrets[name] = fingerprint;
    }
    // A kid's canary row goes before the key itself, so a run that stops between the two leaves the kid live and the
    // next apply retires it again; the delete finds no row the second time.
    for (const action of actions) {
      if (action.kind === "delete-seal-canary") {
        await platformSql(context, deleteCanaryScript(action.kid));
      } else if (action.kind === "retire-seal-key") {
        await context.secrets.retireSealKey(action.kid);
      } else if (action.kind === "issue-seal-key") {
        context.info(`issued seal key ${(await context.secrets.issueSealKey()).kid}`);
      }
    }
  },
};
