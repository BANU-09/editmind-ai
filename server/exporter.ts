import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  mapSourceRangeToTimeline,
  projectCaptionsToTimeline,
  recalculateTimeline,
} from '../src/shared/timelineEngine';
import type { ExportJob, ProjectState } from '../src/shared/types';
import { db, EXPORTS_DIR, MUSIC_DIR, TEMP_DIR } from './db';
import { downloadBlobToFile, isVercelBlobConfigured, uploadFileToBlob } from './blobStorage';
import { probeVideoFile } from './mediaProcessor';

function toAssTimestamp(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssColor(hex: string, alphaHex = '00'): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `&H${alphaHex}FFFFFF`;
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

function makeEven(n: number): number {
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function computeTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  resolution: ExportJob['resolution'],
): { w: number; h: number } {
  const baseLong = resolution === '1080p' ? 1920 : resolution === '480p' ? 854 : 1280;
  const baseShort = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;

  if (srcHeight > srcWidth) {
    // Portrait orientation (e.g. 9:16 -> 720x1280)
    const w = makeEven(baseShort);
    const h = makeEven(w * (srcHeight / Math.max(1, srcWidth)));
    return { w, h };
  }
  if (Math.abs(srcWidth - srcHeight) <= 16) {
    // Square orientation (1:1 -> 720x720)
    const side = makeEven(baseShort);
    return { w: side, h: side };
  }
  // Landscape orientation (e.g. 16:9 -> 1280x720)
  const w = makeEven(baseLong);
  const h = makeEven(w * (srcHeight / Math.max(1, srcWidth)));
  return { w, h };
}

function buildAssSubtitles(state: ProjectState, width: number, height: number): string {
  const projected = projectCaptionsToTimeline(state);
  const scaleRef = Math.min(width, height) / 720;
  const fontSize = Math.max(18, Math.round((state.captionStyle.fontSize || 22) * Math.max(0.75, scaleRef)));
  const primaryColor = hexToAssColor(state.captionStyle.color || '#FFFFFF');
  const highlightColor = hexToAssColor(state.captionStyle.highlightColor || '#22D3EE');
  const opacity = state.captionStyle.backgroundOpacity ?? 0.78;
  const alphaVal = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)));
  const backColour = `&H${alphaVal.toString(16).padStart(2, '0').toUpperCase()}050711`;
  const fontName = (state.captionStyle.fontFamily || 'Sans').replace(/[,:]/g, '');

  const alignment =
    state.captionStyle.position === 'top'
      ? 8
      : state.captionStyle.position === 'center'
        ? 5
        : 2;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},${highlightColor},&H00050711,${backColour},1,0,0,0,100,100,0,0,3,2,0,${alignment},32,32,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  for (const cap of projected) {
    if (state.captionStyle.highlightActiveWord && cap.words.length > 0 && state.captionStyle.mode !== 'word') {
      // Emit active word-highlight dialogue events or inline karaoke tags
      const karaokeText = cap.words
        .map((w) => {
          const cs = Math.max(5, Math.round((w.timelineEnd - w.timelineStart) * 100));
          const cleanW = w.word.replace(/\r?\n/g, ' ').replace(/[{}]/g, '');
          return `{\\kf${cs}}${cleanW}`;
        })
        .join(' ');
      lines.push(
        `Dialogue: 0,${toAssTimestamp(cap.timelineStart)},${toAssTimestamp(cap.timelineEnd)},Default,,0,0,0,,${karaokeText}`,
      );
    } else {
      const cleanText = cap.text.replace(/\r?\n/g, ' ').replace(/[{}]/g, '');
      lines.push(
        `Dialogue: 0,${toAssTimestamp(cap.timelineStart)},${toAssTimestamp(cap.timelineEnd)},Default,,0,0,0,,${cleanText}`,
      );
    }
  }

  return header + lines.join('\n') + '\n';
}

function buildAtempoChain(speed: number): string {
  const parts: string[] = [];
  let rem = Math.min(4, Math.max(0.25, speed));
  while (rem > 2.0) {
    parts.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5) {
    parts.push('atempo=0.5');
    rem /= 0.5;
  }
  parts.push(`atempo=${rem.toFixed(4)}`);
  return parts.join(',');
}

export async function runExportJob(params: {
  jobId: string;
  projectId: string;
  mediaId: string;
  sourceFilePath: string;
  sourceHasAudio: boolean;
  selectedAudioStream?: number;
  state: ProjectState;
  resolution: ExportJob['resolution'];
  quality: ExportJob['quality'];
}): Promise<void> {
  const {
    jobId,
    sourceFilePath,
    sourceHasAudio,
    selectedAudioStream = 0,
    state,
    resolution,
    quality,
  } = params;

  const updateJob = (patch: Partial<ExportJob> & { blobUrl?: string }) => {
    const current = db.prepare('SELECT * FROM exports WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    if (!current) return;
    db.prepare(
      `UPDATE exports SET status = ?, progress = ?, output_path = ?, output_url = ?, blob_url = ?, file_size_bytes = ?, duration_sec = ?, error = ? WHERE id = ?`,
    ).run(
      patch.status ?? current.status,
      patch.progress ?? current.progress,
      patch.outputUrl ? path.join(EXPORTS_DIR, `${jobId}.mp4`) : current.output_path,
      patch.outputUrl ?? current.output_url,
      patch.blobUrl ?? current.blob_url,
      patch.fileSizeBytes ?? current.file_size_bytes,
      patch.durationSec ?? current.duration_sec,
      patch.error ?? current.error,
      jobId,
    );
  };

  try {
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error('Source media file could not be located on disk.');
    }

    updateJob({ status: 'rendering', progress: 8 });

    const { segments, duration: expectedDuration } = recalculateTimeline(state.segments);
    if (segments.length === 0 || expectedDuration <= 0.05) {
      throw new Error('Timeline has no active segments to export.');
    }

    const sourceMeta = await probeVideoFile(sourceFilePath);
    const targetDims = computeTargetDimensions(sourceMeta.width, sourceMeta.height, resolution);
    const safeAudioIdx =
      sourceMeta.audioStreams.length > 0
        ? Math.max(0, Math.min(sourceMeta.audioStreams.length - 1, selectedAudioStream))
        : 0;

    const crf = quality === 'high' ? '18' : quality === 'fast' ? '26' : '22';
    const preset = quality === 'fast' ? 'ultrafast' : 'veryfast';

    const outPath = path.join(EXPORTS_DIR, `${jobId}.mp4`);
    const assPath = path.join(EXPORTS_DIR, `${jobId}.ass`);

    const filterLines: string[] = [];
    const concatInputs: string[] = [];
    const inputArgs: string[] = [];

    segments.forEach((seg, i) => {
      const sStart = Math.max(0, seg.sourceStart);
      const sEnd = Math.max(sStart + 0.05, seg.sourceEnd);
      const sourceClipDur = Math.max(0.05, sEnd - sStart);
      const speed = Math.min(4, Math.max(0.25, seg.speed || 1));
      const tlDur = Math.max(0.05, sourceClipDur / speed);

      inputArgs.push(
        '-ss',
        sStart.toFixed(3),
        '-t',
        sourceClipDur.toFixed(3),
        '-i',
        sourceFilePath,
      );

      filterLines.push(
        `[${i}:v]setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=24,scale=${targetDims.w}:${targetDims.h}:force_original_aspect_ratio=decrease,pad=${targetDims.w}:${targetDims.h}:(ow-iw)/2:(oh-ih)/2:color=#02040A,format=yuv420p[v${i}]`,
      );

      if (sourceHasAudio && sourceMeta.hasAudio && !state.audio.muted && !seg.muted && state.trackVisibility.audio) {
        const vol = Math.max(0, Math.min(2, seg.volume * state.audio.masterVolume));
        const denoise = state.audio.noiseReduction ? 'highpass=f=85,lowpass=f=11000,' : '';
        filterLines.push(
          `[${i}:a:${safeAudioIdx}]asetpts=PTS-STARTPTS,${buildAtempoChain(speed)},${denoise}volume=${vol.toFixed(2)},aformat=sample_rates=24000:channel_layouts=mono[a${i}]`,
        );
      } else {
        filterLines.push(
          `anullsrc=r=24000:cl=mono,atrim=duration=${tlDur.toFixed(3)}[a${i}]`,
        );
      }

      concatInputs.push(`[v${i}][a${i}]`);
    });

    filterLines.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);

    let currentV = '[vcat]';
    let currentA = '[acat]';

    // Apply timeline muteRanges and bleeps accurately onto concatenated audio
    const muteWindows: Array<{ start: number; end: number }> = [];
    const bleepWindows: Array<{ start: number; end: number }> = [];

    for (const mr of state.muteRanges || []) {
      const mapped = mapSourceRangeToTimeline(segments, mr.sourceStart, mr.sourceEnd);
      if (mapped && mapped.timelineEnd > mapped.timelineStart) {
        muteWindows.push({ start: mapped.timelineStart, end: mapped.timelineEnd });
      }
    }
    for (const bl of state.bleeps || []) {
      const mapped = mapSourceRangeToTimeline(segments, bl.sourceStart, bl.sourceEnd);
      if (mapped && mapped.timelineEnd > mapped.timelineStart) {
        muteWindows.push({ start: mapped.timelineStart, end: mapped.timelineEnd });
        bleepWindows.push({ start: mapped.timelineStart, end: mapped.timelineEnd });
      }
    }

    if (muteWindows.length > 0) {
      const enableExpr = muteWindows
        .map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`)
        .join('+');
      filterLines.push(
        `${currentA}volume=enable='${enableExpr}':volume=0[amuted]`,
      );
      currentA = '[amuted]';
    }

    if (bleepWindows.length > 0) {
      const bleepEnableExpr = bleepWindows
        .map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`)
        .join('+');
      filterLines.push(
        `aevalsrc='0.28*sin(2*PI*1000*t)':s=24000:d=${expectedDuration.toFixed(3)},volume=enable='${bleepEnableExpr}':volume=1,volume=enable='not(${bleepEnableExpr})':volume=0[ableep]`,
      );
      filterLines.push(`${currentA}[ableep]amix=inputs=2:duration=first:normalize=0[awithbleep]`);
      currentA = '[awithbleep]';
    }

    // Burn captions if enabled
    if (state.captionsEnabled && state.trackVisibility.captions && state.captions.length > 0) {
      fs.writeFileSync(assPath, buildAssSubtitles(state, targetDims.w, targetDims.h), 'utf8');
      const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filterLines.push(`${currentV}ass='${escapedAss}'[vsub]`);
      currentV = '[vsub]';
    }

    // Apply text overlays via drawtext
    if (state.trackVisibility.overlays && state.overlays.length > 0) {
      state.overlays.forEach((ov, idx) => {
        const nextV = `[vov${idx}]`;
        const safeText = ov.text.replace(/[':\\]/g, '').trim() || 'Text';
        const px = `w*${(ov.x / 100).toFixed(2)}-tw/2`;
        const py = `h*${(ov.y / 100).toFixed(2)}-th/2`;
        const fSize = Math.max(16, Math.round(ov.fontSize * (targetDims.h / 720)));
        filterLines.push(
          `${currentV}drawtext=text='${safeText}':fontcolor=${ov.color}:fontsize=${fSize}:x=${px}:y=${py}:box=1:boxcolor=black@0.65:boxborderw=10:enable='between(t,${ov.timelineStart.toFixed(2)},${ov.timelineEnd.toFixed(2)})'${nextV}`,
        );
        currentV = nextV;
      });
    }

    // Apply optional custom uploaded music or preset ambient music bed
    let downloadedMusicTempPath = '';
    if (state.audio.musicEnabled && state.trackVisibility.music) {
      const mVol = Math.max(0.02, Math.min(0.95, state.audio.musicVolume));
      const fadeIn = Math.max(0.05, state.audio.musicFadeInSec);
      const fadeOutDur = Math.max(0.1, state.audio.musicFadeOutSec);
      const fadeOutStart = Math.max(0.05, expectedDuration - fadeOutDur);
      const customName = state.audio.customMusicUrl
        ? path.basename(state.audio.customMusicUrl.split('?')[0])
        : '';
      let customPath = customName ? path.join(MUSIC_DIR, customName) : '';
      if ((!customPath || !fs.existsSync(customPath)) && state.audio.customMusicUrl?.startsWith('https://')) {
        downloadedMusicTempPath = path.join(TEMP_DIR, `bgm-${jobId}-${customName || 'track.mp3'}`);
        try {
          await downloadBlobToFile(state.audio.customMusicUrl, downloadedMusicTempPath);
          customPath = downloadedMusicTempPath;
        } catch {
          downloadedMusicTempPath = '';
        }
      }

      if (customPath && fs.existsSync(customPath)) {
        const musicInputIdx = segments.length;
        const startOffset = Math.max(0, state.audio.musicStartOffsetSec || 0);
        inputArgs.push('-stream_loop', '-1', '-ss', startOffset.toFixed(2), '-i', customPath);
        filterLines.push(
          `[${musicInputIdx}:a]atrim=duration=${expectedDuration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=24000:channel_layouts=mono,afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOutDur.toFixed(2)},volume=${mVol.toFixed(2)}[mbed]`,
        );
      } else {
        const chordExpr =
          state.audio.musicPreset === 'cinematic-pad'
            ? '0.14*sin(2*PI*165*t)+0.11*sin(2*PI*247*t)'
            : state.audio.musicPreset === 'upbeat-synth'
              ? '0.15*sin(2*PI*262*t)+0.1*sin(2*PI*392*t)'
              : '0.15*sin(2*PI*220*t)+0.1*sin(2*PI*330*t)';
        filterLines.push(
          `aevalsrc='${chordExpr}':s=24000:d=${expectedDuration.toFixed(3)},afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOutDur.toFixed(2)},volume=${mVol.toFixed(2)}[mbed]`,
        );
      }
      filterLines.push(`${currentA}[mbed]amix=inputs=2:duration=first:normalize=0[amix]`);
      currentA = '[amix]';
    }

    // Apply master audio fade in/out if configured
    if (state.audio.fadeInSec > 0 || state.audio.fadeOutSec > 0) {
      const parts: string[] = [];
      if (state.audio.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${state.audio.fadeInSec.toFixed(2)}`);
      if (state.audio.fadeOutSec > 0) {
        const st = Math.max(0, expectedDuration - state.audio.fadeOutSec);
        parts.push(`afade=t=out:st=${st.toFixed(2)}:d=${state.audio.fadeOutSec.toFixed(2)}`);
      }
      filterLines.push(`${currentA}${parts.join(',')}[afaded]`);
      currentA = '[afaded]';
    }

    const filterComplex = filterLines.join(';');

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        ...inputArgs,
        '-filter_complex',
        filterComplex,
        '-map',
        currentV,
        '-map',
        currentA,
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-crf',
        crf,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        outPath,
      ];

      const proc = spawn('ffmpeg', args);
      let stderrLog = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/out_time_ms=(\d+)/);
        if (match) {
          const outSec = parseInt(match[1], 10) / 1_000_000;
          const pct = Math.min(92, Math.max(12, Math.round((outSec / expectedDuration) * 85) + 10));
          updateJob({ status: 'rendering', progress: pct });
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrLog += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg render exited with code ${code}: ${stderrLog.slice(-400)}`));
      });
    });

    if (fs.existsSync(assPath)) fs.rmSync(assPath, { force: true });
    if (downloadedMusicTempPath && fs.existsSync(downloadedMusicTempPath)) {
      fs.rmSync(downloadedMusicTempPath, { force: true });
    }

    updateJob({ status: 'validating', progress: 96 });

    if (!fs.existsSync(outPath)) {
      throw new Error('Export failed: output MP4 file was not created.');
    }

    const stats = fs.statSync(outPath);
    if (stats.size < 1024) {
      throw new Error('Export failed: generated file is invalid or empty.');
    }

    const probed = await probeVideoFile(outPath);
    if (probed.durationSec <= 0) {
      throw new Error('Export validation failed: rendered MP4 has zero duration.');
    }

    let blobUrl: string | undefined;
    if (isVercelBlobConfigured()) {
      try {
        updateJob({ status: 'validating', progress: 98 });
        const uploaded = await uploadFileToBlob({
          localPath: outPath,
          blobPathname: `exports/${jobId}.mp4`,
          contentType: 'video/mp4',
        });
        if (uploaded) blobUrl = uploaded.url;
      } catch (blobErr) {
        console.warn('[exporter] Vercel Blob upload skipped/failed:', blobErr instanceof Error ? blobErr.message : blobErr);
      }
    }

    updateJob({
      status: 'completed',
      progress: 100,
      outputUrl: `/api/exports/${jobId}/download`,
      blobUrl,
      fileSizeBytes: stats.size,
      durationSec: probed.durationSec,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown export failure';
    updateJob({
      status: 'failed',
      progress: 0,
      error: msg,
    });
  }
}
