// The N-1 contract check between two consecutive releases.
// Platform migrates first and Studio rolls later, and Studio can always roll back one release,
// so every pairing of this release with the previous one must share a contract version.

export interface ContractSets {
  platformPublishes: readonly number[];
  studioSupports: readonly number[];
}

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function list(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}

function intersects(a: readonly number[], b: readonly number[]): boolean {
  return a.some((value) => b.includes(value));
}

/**
 * Returns one problem per pairing that shares no contract version, or an empty list when the release is compatible.
 * `previous` is null for the first release, which is checked only against itself.
 */
export function checkContractCompat(current: ContractSets, previous: ContractSets | null): string[] {
  const problems: string[] = [];
  if (!intersects(current.platformPublishes, current.studioSupports)) {
    problems.push(
      `Platform publishes ${list(current.platformPublishes)} and Studio supports ${list(current.studioSupports)} in this release, so they share no contract version`,
    );
  }
  if (previous === null) return problems;
  if (!intersects(current.platformPublishes, previous.studioSupports)) {
    problems.push(
      `Platform publishes ${list(current.platformPublishes)} but the previous Studio supports only ${list(previous.studioSupports)}, so the previous Studio cannot run during an upgrade or after a Studio rollback`,
    );
  }
  if (!intersects(current.studioSupports, previous.platformPublishes)) {
    problems.push(
      `Studio supports ${list(current.studioSupports)} but the previous Platform publishes only ${list(previous.platformPublishes)}, so Studio cannot run against a Platform restored to the previous release`,
    );
  }
  return problems;
}

function parseReleaseVersion(version: string): [number, number, number] {
  const match = RELEASE_VERSION.exec(version);
  if (match === null) throw new Error(`'${version}' is not a release version of the form MAJOR.MINOR.PATCH`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Orders release versions numerically: negative when a is older than b. */
export function compareReleaseVersions(a: string, b: string): number {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Returns the newest recorded release older than `current`, or undefined when none is recorded.
 * A recorded release newer than `current` means the release config went backwards, which is refused.
 */
export function findPreviousRelease(current: string, recorded: readonly string[]): string | undefined {
  parseReleaseVersion(current);
  let previous: string | undefined;
  for (const version of recorded) {
    const order = compareReleaseVersions(version, current);
    if (order > 0) throw new Error(`release/history holds ${version}, which is newer than the release version ${current}`);
    if (order < 0 && (previous === undefined || compareReleaseVersions(version, previous) > 0)) previous = version;
  }
  return previous;
}
