// Compiles the installer into one self-contained binary per Linux target.
// It first runs embed-release, then embeds generated/embedded.json and the pinned Studio chart next to the code,
// where Bun.embeddedFiles finds them by name. The .json file loader applies to entrypoints only, because
// every JSON module the code imports carries `with { type: "json" }`.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { embedRelease } from "./embed-release";

const root = join(import.meta.dir, "..");
const entrypoint = join(root, "src/cli/main.ts");
const outDir = join(root, "dist");

// Only linux-x64, because the Platform image of the release is built for linux/amd64 alone; linux-arm64 returns when
// the Platform image is multi-arch.
const targets = [{ target: "bun-linux-x64", outfile: "libredb-installer-linux-x64" }] as const;

const { file: chartFile } = await embedRelease();
const embeddedFiles = [join(root, "generated", "embedded.json"), join(root, "generated", chartFile)];

rmSync(outDir, { recursive: true, force: true });

for (const { target, outfile } of targets) {
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      "--loader",
      ".json:file",
      "--loader",
      ".tgz:file",
      "--asset-naming",
      "[name].[ext]",
      entrypoint,
      ...embeddedFiles,
      "--outfile",
      join(outDir, outfile),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bun build --compile for ${target} failed with exit code ${result.exitCode}`);
  }
}
