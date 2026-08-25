export interface ReleaseSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
}

const RELEASE_SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseReleaseSemver(value: string): ReleaseSemver | null {
  const match = RELEASE_SEMVER.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => /^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function isReleaseSemver(value: string): boolean {
  return parseReleaseSemver(value) !== null;
}

export function compareReleaseSemver(leftValue: string, rightValue: string): number {
  const left = parseReleaseSemver(leftValue);
  const right = parseReleaseSemver(rightValue);
  if (!left || !right) throw new TypeError('Invalid release semver');

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1;
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
