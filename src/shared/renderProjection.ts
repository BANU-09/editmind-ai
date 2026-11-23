import type { TextOverlay, TimelineSegment } from './types';

/** A single source interval can survive in multiple (and reordered) timeline slices. */
export function visibleIntervals(
  segments: TimelineSegment[],
  ranges: { sourceStart: number; sourceEnd: number }[],
) {
  return segments.flatMap((segment) =>
    ranges.flatMap((range) => {
      const start = Math.max(segment.sourceStart, range.sourceStart);
      const end = Math.min(segment.sourceEnd, range.sourceEnd);
      if (end <= start) return [];
      return [
        {
          start: segment.timelineStart + (start - segment.sourceStart) / segment.speed,
          end: segment.timelineStart + (end - segment.sourceStart) / segment.speed,
        },
      ];
    }),
  );
}

export function projectOverlay(segments: TimelineSegment[], overlay: TextOverlay) {
  if (!overlay.sourceRanges) return [{ start: overlay.timelineStart, end: overlay.timelineEnd }];
  return visibleIntervals(
    segments,
    overlay.sourceRanges.map((r) => ({ sourceStart: r.start, sourceEnd: r.end })),
  );
}
