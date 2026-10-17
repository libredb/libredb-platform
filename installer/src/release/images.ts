// The effective image references of a release: upstream by digest, or rewritten to a registry mirror.
import { IMAGE_NAMES, type ImageEntry, type ImageName, type ReleaseManifest } from "./manifest";

export interface EffectiveImage {
  name: ImageName;
  reference: string;
}

/**
 * Returns `<repository>@sha256:<digest>`, or `<registry>/<last path segment>@sha256:<digest>` when a mirror is set.
 * The tag is left out on purpose: the digest alone decides what runs.
 */
export function imageReference(entry: ImageEntry, registry: string | undefined): string {
  if (registry === undefined) return `${entry.repository}@${entry.digest}`;
  const name = entry.repository.slice(entry.repository.lastIndexOf("/") + 1);
  return `${registry}/${name}@${entry.digest}`;
}

/** Lists every image of the release in manifest order with its effective reference. */
export function effectiveImages(manifest: ReleaseManifest, registry: string | undefined): EffectiveImage[] {
  return IMAGE_NAMES.map((name) => ({ name, reference: imageReference(manifest.images[name], registry) }));
}
