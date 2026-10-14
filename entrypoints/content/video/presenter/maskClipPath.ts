import { MaskCoverage } from '@/entrypoints/content/presentation/maskCoverage';

import type { ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';

const formatPx = (value: number): string => String(Math.round(value * 100) / 100);

export function maskClipPath(entries: readonly VerdictEntry[], content: ContentRect): string | null {
  const segments: string[] = [];
  for (const entry of entries) {
    const coverage = MaskCoverage.from(entry.predictions, entry.maskTransform, entry.width, entry.height);
    for (const rect of coverage?.rects(content) ?? []) {
      const left = formatPx(rect.left);
      segments.push(`M${left} ${formatPx(rect.top)}H${formatPx(rect.right)}V${formatPx(rect.bottom)}H${left}Z`);
    }
  }
  return segments.length > 0 ? segments.join('') : null;
}
