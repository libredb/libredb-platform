// The release manifest: what one LibreDB release installs, pinned by digest.
// The committed source is release/release.config.json, and the binary embeds it.
import { z } from "zod";
import { formatPath } from "../config/schema";

/** The images of a release, in the order the installer lists them. */
export const IMAGE_NAMES = ["platform", "studio", "keycloak", "postgres", "edge"] as const;
export type ImageName = (typeof IMAGE_NAMES)[number];

/** A manifest that cannot be used, with one line per problem, each prefixed by its JSON path. */
export class ReleaseManifestError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.name = "ReleaseManifestError";
    this.issues = issues;
  }
}

// An upstream version such as 26.8.1 or 18.6, or a build of a git commit recorded as git:<40 hex>.
const VERSION = /^(?:\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?|git:[0-9a-f]{40})$/;

const version = z
  .string({ error: (issue) => (issue.input === undefined ? "every image declares its version" : undefined) })
  .regex(VERSION, "expected a version such as 26.8.1, or git:<40 hex> for a build of a git commit");

const repository = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/,
    "expected a fully qualified repository such as quay.io/keycloak/keycloak, without a tag or digest",
  );

const digestMessage = "every image is pinned by a sha256 digest, such as sha256:<64 hex>";

const image = z
  .object({
    repository,
    version,
    digest: z.string({ error: digestMessage }).regex(/^sha256:[0-9a-f]{64}$/, digestMessage),
  })
  .strict();

const imageEntry = z.custom<unknown>((value) => value !== undefined, "missing image entry").pipe(image);

const minimumVersion = z.string().regex(/^\d+\.\d+\.\d+$/, "expected a MAJOR.MINOR.PATCH version");

const reportedVersionMessage = "expected the version the pinned Studio build reports, such as 0.18.3";

// The version Studio reports as studio_version in its heartbeat: a release reports its own version, and a
// build of a git commit reports the version of its package.json, which the build injects.
const reportedVersion = z
  .string({ error: reportedVersionMessage })
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, reportedVersionMessage);

const contractSet = z
  .array(z.number().int().positive())
  .min(1, "expected at least one contract version")
  .refine((values) => new Set(values).size === values.length, "expected distinct contract versions");

export const releaseManifest = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a release version of the form MAJOR.MINOR.PATCH"),
    images: z
      .object({
        platform: imageEntry,
        studio: imageEntry,
        keycloak: imageEntry,
        postgres: imageEntry,
        edge: imageEntry,
      })
      .strict(),
    studioChart: z
      .object({
        name: z.literal("libredb-studio"),
        version: z
          .string()
          .regex(VERSION, "expected a chart version such as 0.1.92, or git:<40 hex> for a build of a git commit"),
        repository: z.url({ protocol: /^https$/, error: "expected the https URL of the chart repository" }),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected the 64 lowercase hex characters of a sha256"),
      })
      .strict(),
    minimums: z
      .object({
        dockerEngine: minimumVersion,
        compose: minimumVersion,
        kubernetes: minimumVersion,
      })
      .strict(),
    studio: z
      .object({
        logoutHintVerified: z.boolean(),
        reportedVersion,
      })
      .strict(),
    contracts: z
      .object({
        platformPublishes: contractSet,
        studioSupports: contractSet,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const pinned = manifest.images.studio.version;
    if (pinned.startsWith("git:") || manifest.studio.reportedVersion === pinned) return;
    context.addIssue({
      code: "custom",
      path: ["studio", "reportedVersion"],
      message: `Studio is pinned as release ${pinned}, which reports ${pinned}, not ${manifest.studio.reportedVersion}`,
    });
  });

export type ReleaseManifest = z.output<typeof releaseManifest>;
export type ImageEntry = z.output<typeof image>;

/** Validates a raw manifest document. Throws ReleaseManifestError listing every problem. */
export function parseReleaseManifest(raw: unknown): ReleaseManifest {
  const result = releaseManifest.safeParse(raw);
  if (!result.success) {
    throw new ReleaseManifestError(result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`));
  }
  return result.data;
}
