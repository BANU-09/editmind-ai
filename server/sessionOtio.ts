import type { MediaAnalysis, ProjectState, TimelineSegment } from '../src/shared/types';
import { projectCaptionsToTimeline } from '../src/shared/timelineEngine';
import { timePolicy, timelineHash } from './sessionTypes';

/** OTIO source_range.duration is the clip's duration in its parent track.
 * The LinearTimeWarp describes the sampling rate of underlying source media.
 * Preserve the true source out-point for adapters that ignore speed effects. */
export function toOtio(state: ProjectState, analysis: MediaAnalysis, sourceUrl: string) {
  const rate = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 24;
  const time = (seconds: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: seconds * rate });
  const range = (start: number, length: number) => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: time(start),
    duration: time(length),
  });
  const item = { metadata: {}, source_range: null, effects: [], markers: [], enabled: true };
  const projected = projectCaptionsToTimeline(state);
  function clip(seg: TimelineSegment, kind: 'Audio' | 'Video') {
    const effects =
      seg.speed === 1
        ? []
        : [
            {
              OTIO_SCHEMA: 'LinearTimeWarp.1',
              name: 'Playback speed',
              effect_name: 'LinearTimeWarp',
              time_scalar: seg.speed,
              metadata: {},
            },
          ];
    const marker = (name: string, at: number, duration: number, metadata: object) => ({
      OTIO_SCHEMA: 'Marker.2',
      name,
      marked_range: range(at, duration),
      color: 'CYAN',
      metadata: { editmind: metadata },
    });
    const markers =
      kind === 'Video'
        ? projected
            .filter((c) => c.timelineStart >= seg.timelineStart && c.timelineStart < seg.timelineEnd)
            .map((c) =>
              marker(
                c.text,
                seg.sourceStart + c.timelineStart - seg.timelineStart,
                Math.min(c.timelineEnd, seg.timelineEnd) - c.timelineStart,
                {
                  kind: 'caption',
                  source_start: c.sourceStart,
                  source_end: c.sourceEnd,
                  style: { ...state.captionStyle, ...c.styleOverride },
                },
              ),
            )
        : [
            ...(state.muteRanges ?? []).map((r) => ({ ...r, kind: 'mute' })),
            ...state.bleeps.map((r) => ({ ...r, kind: 'bleep' })),
          ].flatMap((r) => {
            const lo = Math.max(seg.sourceStart, r.sourceStart),
              hi = Math.min(seg.sourceEnd, r.sourceEnd);
            return hi > lo
              ? [
                  marker(
                    r.label,
                    seg.sourceStart + (lo - seg.sourceStart) / seg.speed,
                    (hi - lo) / seg.speed,
                    { kind: r.kind, source_start: lo, source_end: hi },
                  ),
                ]
              : [];
          });
    return {
      OTIO_SCHEMA: 'Clip.2',
      ...item,
      name: seg.label,
      effects,
      markers,
      enabled:
        kind === 'Video'
          ? state.trackVisibility.video
          : state.trackVisibility.audio && !seg.muted && !state.audio.muted,
      metadata: {
        editmind: {
          source_start: seg.sourceStart,
          source_end: seg.sourceEnd,
          playback_rate: seg.speed,
          volume: seg.volume,
        },
      },
      source_range: range(seg.sourceStart, seg.timelineEnd - seg.timelineStart),
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: {},
          name: 'Original recording',
          target_url: sourceUrl,
          available_image_bounds: null,
          available_range: range(0, analysis.durationSec),
        },
      },
    };
  }
  function track(kind: 'Audio' | 'Video') {
    return {
      OTIO_SCHEMA: 'Track.1',
      ...item,
      name: kind,
      kind,
      children: state.segments.map((s) => clip(s, kind)),
    };
  }
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: 'EditMind timeline',
    global_start_time: time(0),
    metadata: {
      editmind: {
        time_policy: timePolicy,
        timeline_hash: timelineHash(state),
        duration_s: state.duration,
        overlays: state.overlays,
        audio: state.audio,
      },
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      ...item,
      name: 'Tracks',
      children: [track('Video'), ...(analysis.hasAudio ? [track('Audio')] : [])],
    },
  };
}
