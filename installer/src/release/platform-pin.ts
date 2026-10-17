// The Platform pin of a release against the registry: the pinned digest is the one the registry reports for the pinned
// Platform version, so a release cannot ship a placeholder digest or the digest of another build of that version.
import type { ReleaseManifest } from "./manifest";
import { type Fetcher, manifestUrl, registryDigest } from "./studio-tag";

/**
 * Returns the reason the release's Platform digest differs from the one the registry reports for the pinned version,
 * or an empty list. It asks the upstream repository, or a registry mirror given as `<host>[/<path>]`.
 */
export async function platformPinProblems(
  manifest: ReleaseManifest,
  registry: string | undefined,
  fetcher: Fetcher,
): Promise<string[]> {
  const platform = manifest.images.platform;
  const reported = await registryDigest(manifestUrl(platform, registry), fetcher);
  if (reported === platform.digest) return [];
  return [
    `the release pins Platform ${platform.version} at ${platform.digest}, but the registry reports ${reported} for that version`,
  ];
}
