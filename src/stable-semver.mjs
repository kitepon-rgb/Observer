export function isStableSemverAtLeast(value, minimum) {
  const actualParts = parseStableSemver(value);
  const minimumParts = parseStableSemver(minimum);
  if (actualParts === null || minimumParts === null) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) return actualParts[index] > minimumParts[index];
  }
  return true;
}

function parseStableSemver(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
