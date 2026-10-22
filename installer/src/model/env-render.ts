// Renders one app environment from the generated descriptors of contracts/env-inventory.yaml: every variable the
// installer writes under the conditions that hold, with its value template filled from the renderer's inputs.
import type { EnvDescriptor, EnvWriteCondition } from "../contracts/studio";
import type { DesiredInstallation } from "./desired";

/** Which write conditions of the inventory hold for this installation. */
export type EnvConditions = Readonly<Record<EnvWriteCondition, boolean>>;

/** An environment that cannot be rendered. Its message names the variable and never holds a value. */
export class EnvRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvRenderError";
  }
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** Returns the written variables in inventory order. A key outside the descriptors cannot appear in the result. */
export function renderEnv<K extends string>(
  descriptors: Readonly<Record<K, EnvDescriptor>>,
  inputs: Readonly<Record<string, string>>,
  conditions: EnvConditions,
): Partial<Record<K, string>> {
  const env: Partial<Record<K, string>> = {};
  for (const key of Object.keys(descriptors) as K[]) {
    const { value, when } = descriptors[key];
    if (when === null || value === null || !conditions[when]) continue;
    const rendered = value.replace(PLACEHOLDER, (_, name: string) => {
      const input = inputs[name];
      if (input === undefined) {
        throw new EnvRenderError(`${key}: the value template names {{${name}}}, which this environment has no input for`);
      }
      return input;
    });
    if (/[\r\n\0]/.test(rendered)) throw new EnvRenderError(`${key}: the value contains a line break or a NUL character`);
    env[key] = rendered;
  }
  return env;
}

/** The conditions the caller knows apart from the desired model. */
export interface CallerConditions {
  /** The caller knows the size of the managed PostgreSQL volume. */
  volumeSize: boolean;
  /** platform.authSecretPreviousFile is set, so a Platform rotation window is open. */
  authSecretPrevious: boolean;
}

/** The conditions the desired model decides, and those only the caller knows. */
export function envConditions(desired: DesiredInstallation, caller: CallerConditions): EnvConditions {
  return {
    always: true,
    httpsProxy: desired.httpsProxy !== undefined,
    keycloakAdminUrl: desired.keycloak.platformAdminUrl !== undefined,
    logoutHintVerified: desired.logoutHintVerified,
    mobileClient: desired.clients.mobile !== undefined,
    volumeSize: caller.volumeSize,
    authSecretPrevious: caller.authSecretPrevious,
  };
}

/** The renderer input for network.httpsProxy, present only when a proxy is configured. */
export function proxyInputs(desired: DesiredInstallation): Record<string, string> {
  return desired.httpsProxy === undefined ? {} : { httpsProxy: desired.httpsProxy };
}
