export const LEVEL0_SPACING_US = 500_000;
export const FINEST_SPACING_US = 62_500;

export const toPointUs = (seconds: number): number => Math.ceil(Math.round(seconds * 1e7) / 10);

export const pointToSec = (pointUs: number): number => pointUs / 1e6;

export function latticePointsIn(startUs: number, endUs: number, spacingUs = LEVEL0_SPACING_US): number[] {
  const points: number[] = [];
  for (let point = Math.ceil(startUs / spacingUs) * spacingUs; point < endUs; point += spacingUs) {
    points.push(point);
  }
  return points;
}

export function probeBetween(earlierUs: number, laterUs: number): number | null {
  const midpointUs = (earlierUs + laterUs) / 2;
  for (let spacingUs = LEVEL0_SPACING_US; spacingUs >= FINEST_SPACING_US; spacingUs /= 2) {
    const nearest = Math.round(midpointUs / spacingUs) * spacingUs;
    const candidates = [nearest, nearest - spacingUs, nearest + spacingUs]
      .filter(point => point > earlierUs && point < laterUs)
      .sort((a, b) => Math.abs(a - midpointUs) - Math.abs(b - midpointUs) || a - b);
    const [best] = candidates;
    if (best !== undefined) return best;
  }
  return null;
}

export function latticeSpacingOf(pointUs: number): number {
  for (let spacingUs = LEVEL0_SPACING_US; spacingUs >= FINEST_SPACING_US; spacingUs /= 2) {
    if (pointUs % spacingUs === 0) return spacingUs;
  }
  return LEVEL0_SPACING_US;
}
