import pkg from "../../../package.json" with { type: "json" };
import type { Output } from "../main";
import { embeddedRelease } from "../release";

export const INSTALLER_VERSION: string = pkg.version;

const list = (values: readonly number[]) => `[${values.join(", ")}]`;

export function runVersion(io: Output): number {
  const release = embeddedRelease();
  io.stdout(
    `libredb-installer ${INSTALLER_VERSION}\n` +
      `release ${release.version}\n` +
      `platformPublishes ${list(release.contracts.platformPublishes)}\n` +
      `studioSupports ${list(release.contracts.studioSupports)}\n`,
  );
  return 0;
}
