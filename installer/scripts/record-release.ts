// Records a cut release: writes release/history/<version>.json from release/release.config.json,
// after the history and contract checks of release:check, so the next release is checked against this one.
// It skips the checks of the Studio pin against STUDIO_TAG, the chart and the registry, and of the Platform pin
// against the registry, so run release:check for those first.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, HISTORY_DIR, readManifest, releaseProblems } from "./check-release-compat";

const current = readManifest(CONFIG_PATH);
const { problems } = releaseProblems(current);
if (problems.length > 0) {
  process.stderr.write(`release ${current.version} cannot be recorded:\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}
const target = join(HISTORY_DIR, `${current.version}.json`);
writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
process.stdout.write(`recorded release/history/${current.version}.json\n`);
