// The release manifest the binary embeds: the committed release config, validated when first used.
import releaseConfig from "../../release/release.config.json" with { type: "json" };
import { parseReleaseManifest, type ReleaseManifest } from "../release/manifest";

let cached: ReleaseManifest | undefined;

export function embeddedRelease(): ReleaseManifest {
  cached ??= parseReleaseManifest(releaseConfig);
  return cached;
}
