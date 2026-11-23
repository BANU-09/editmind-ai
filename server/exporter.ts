import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { projectCaptionsToTimeline, recalculateTimeline } from '../src/shared/timelineEngine';
import { projectOverlay, visibleIntervals } from '../src/shared/renderProjection';
import { musicLoop, musicSampleRate } from '../src/shared/musicBed';
import type { ExportJob, ProjectState } from '../src/shared/types';
import { db, EXPORTS_DIR, MUSIC_DIR, TEMP_DIR } from './db';
import { downloadBlobToFile, isVercelBlobConfigured, uploadFileToBlob } from './blobStorage';
import { probeVideoFile } from './mediaProcessor';

function toAssTimestamp(sec: number): string {
  const ticks=Math.round(Math.max(0,sec)*100);
  const s=ticks/100;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = ticks%100;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssColor(hex: string, alphaHex = '00'): string {
  const clean = hex.replace('#', '');
  if (!/^[a-f\d]{6}$/i.test(clean)) return `&H${alphaHex}FFFFFF`;
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
    const style=cap.styleOverride;
    const colorTag=style?.color ? '\\1c'+hexToAssColor(style.color).replace('&H00','&H')+'&' : '';
    const sizeTag=style?.fontSize ? '\\fs'+Math.max(12,Math.round(style.fontSize*Math.max(0.75,scaleRef))) : '';
    const posTag=style?.position ? '\\an'+({top:8,center:5,bottom:2}[style.position]) : '';
    const tags=colorTag || sizeTag || posTag ? '{'+colorTag+sizeTag+posTag+'}' : '';
    if ((style?.highlightActiveWord??state.captionStyle.highlightActiveWord) && cap.words.length > 0 && state.captionStyle.mode !== 'word') {
      // Emit active word-highlight dialogue events or inline karaoke tags
      const karaokeText = cap.words
        .map((w) => {
          const cs = Math.max(1, Math.round((w.timelineEnd - w.timelineStart) * 100));
          const cleanW = w.word.replace(/\r?\n/g, ' ').replace(/[{}]/g, '');
          const startCs=Math.max(0,Math.round((w.timelineStart-cap.timelineStart)*100));
          return `{\\kt${startCs}\\kf${cs}}${cleanW}`;
        })
        .join(' ');
      lines.push(
        `Dialogue: 0,${toAssTimestamp(cap.timelineStart)},${toAssTimestamp(cap.timelineEnd)},Default,,0,0,0,,${tags}${karaokeText}`,
      );
    } else {
      const cleanText = cap.text.replace(/\r?\n/g, ' ').replace(/[{}]/g, '');
      lines.push(
        `Dialogue: 0,${toAssTimestamp(cap.timelineStart)},${toAssTimestamp(cap.timelineEnd)},Default,,0,0,0,,${tags}${cleanText}`,
      );
    }
  }
  if (state.trackVisibility.overlays) {
    for (const overlay of state.overlays) {
      const font=Math.max(12,Math.round(overlay.fontSize*height/720));
      const color=hexToAssColor(overlay.color).replace('&H00','&H')+'&';
      const x=Math.round(width*overlay.x/100), y=Math.round(height*overlay.y/100);
      const label=overlay.text.replace(/[{}]/g,'').replace(/\r?\n/g,'\\N');
      for (const range of projectOverlay(state.segments,overlay)) {
        lines.push(`Dialogue: 1,${toAssTimestamp(range.start)},${toAssTimestamp(range.end)},Default,,0,0,0,,{\\an5\\pos(${x},${y})\\fs${font}\\1c${color}}${label}`);
      }
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

interface RenderRequest {
  jobId: string;
  projectId: string;
  mediaId: string;
  sourceFilePath: string;
  sourceHasAudio: boolean;
  selectedAudioStream?: number;
  state: ProjectState;
  resolution: ExportJob['resolution'];
  quality: ExportJob['quality'];
}
// FFmpeg renders share a bounded CPU and memory budget in the media worker.
let lastRender:Promise<void>=Promise.resolve();
const scheduledRenders=new Map<string,Promise<void>>();
export function runExportJob(params:RenderRequest):Promise<void> {
  const existing=scheduledRenders.get(params.jobId);
  if(existing) return existing;
  db.prepare('UPDATE exports SET render_request_json=? WHERE id=?').run(JSON.stringify(params),params.jobId);
  const task=lastRender.then(()=>render(params)).finally(()=>scheduledRenders.delete(params.jobId));
  scheduledRenders.set(params.jobId,task);
  lastRender=task.catch(()=>{});
  return task;
}
export function resumeIncompleteRenders() {
  const rows=db.prepare("SELECT id,render_request_json FROM exports WHERE status IN ('queued','rendering','validating') AND render_request_json IS NOT NULL ORDER BY created_at").all() as {id:string;render_request_json:string}[];
  for (const row of rows) {
    try {
      const params=JSON.parse(row.render_request_json) as RenderRequest;
      if(params.jobId!==row.id) throw new Error('Invalid saved render request');
      void runExportJob(params);
    } catch {
      db.prepare("UPDATE exports SET status='failed',error='Could not restore the saved render request.' WHERE id=?").run(row.id);
    }
  }
}
async function render(params:RenderRequest):Promise<void> {
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
    if (patch.status==='completed' || patch.status==='failed') db.prepare('UPDATE exports SET render_request_json=NULL WHERE id=?').run(jobId);
  };

  let workDir='';
  let downloadedMusicTempPath='';
  try {
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error('Source media file could not be located on disk.');
    }

    updateJob({ status: 'rendering', progress: 8 });

    const { segments: timeline, duration: expectedDuration } = recalculateTimeline(state.segments);
    // Timeline labels and captions do not introduce media cuts.
    const segments: typeof timeline = [];
    for (const seg of timeline) {
      const prev=segments.at(-1);
      if (prev && Math.abs(prev.sourceEnd-seg.sourceStart)<0.001 && prev.speed===seg.speed && prev.volume===seg.volume && prev.muted===seg.muted) {
        prev.sourceEnd=seg.sourceEnd;
        prev.timelineEnd=seg.timelineEnd;
      } else segments.push({...seg});
    }
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
    workDir=fs.mkdtempSync(path.join(TEMP_DIR,'render-'));

    const filterLines: string[] = [];
    const concatInputs: string[] = [];
    const inputArgs: string[] = [];

    const sourceAudio=sourceMeta.audioStreams[safeAudioIdx];
    const fullSpan=segments.length===1 && segments[0].sourceStart===0 && Math.abs(segments[0].sourceEnd-sourceMeta.durationSec)<0.025 && segments[0].speed===1;
    const frameSec=1/sourceMeta.fps;
    const audioAligned=sourceAudio && Math.abs(sourceAudio.startTime || 0)<=0.001 && sourceAudio.durationSec!==undefined && Math.abs(sourceAudio.durationSec-expectedDuration)<=frameSec;
    const untouchedAudio=fullSpan && audioAligned && !segments[0].muted && segments[0].volume===1 && state.audio.masterVolume===1 && !state.audio.muted && state.trackVisibility.audio && !state.audio.noiseReduction && !state.audio.fadeInSec && !state.audio.fadeOutSec && !state.bleeps.length && !state.muteRanges?.length && !(state.audio.musicEnabled && state.trackVisibility.music);
    const includeAudio=!!sourceAudio || (state.audio.musicEnabled && state.trackVisibility.music) || state.bleeps.length>0;
    if (sourceHasAudio && !sourceMeta.hasAudio) throw new Error('The selected source audio stream could not be read.');
    const copyVideo=fullSpan && !sourceMeta.variableFrameRate && sourceMeta.videoDurationSec!==undefined && Math.abs(sourceMeta.videoDurationSec-expectedDuration)<=frameSec && sourceMeta.codec==='h264' && sourceMeta.width===targetDims.w && sourceMeta.height===targetDims.h &&
      !(state.captionsEnabled && state.trackVisibility.captions && state.captions.length) &&
      !(state.trackVisibility.overlays && state.overlays.length);
    const copyAudio=untouchedAudio && ['aac','mp3','alac','ac3','eac3'].includes(sourceAudio.codec);
    const rate=sourceAudio?.sampleRate || 48000;
    const layout=sourceAudio?.channelLayout && /^[a-zA-Z0-9.()_]+$/.test(sourceAudio.channelLayout) ? sourceAudio.channelLayout : 'stereo';
    segments.forEach((seg, i) => {
      const sStart = Math.max(0, seg.sourceStart);
      const sEnd = seg.sourceEnd;
      const speed = Math.min(4, Math.max(0.25, seg.speed || 1));
      // Sample the output on one global frame grid. Rounding every slice length
      // independently accumulates a frame of drift for each small edit.
      const firstFrame=Math.round(seg.timelineStart*sourceMeta.fps);
      const frames=Math.round(seg.timelineEnd*sourceMeta.fps)-firstFrame;
      const samples=Math.round(seg.timelineEnd*rate)-Math.round(seg.timelineStart*rate);
      // Decode some preceding footage so a cut that starts between source frames
      // can reuse the preceding frame, even when it is followed by a slow motion edit.
      const seekStart=fullSpan?0:Math.max(0,sStart-Math.max(0.5,2*frameSec));
      const offset=sStart-seekStart;
      if (!fullSpan) inputArgs.push('-ss',seekStart.toFixed(6),'-t',(sEnd-seekStart+2*frameSec).toFixed(6));
      inputArgs.push('-threads','2','-i',path.resolve(sourceFilePath));

      if (!copyVideo && frames>0) {
        const phase=seg.timelineStart-firstFrame/sourceMeta.fps;
        filterLines.push(`[${i}:v]settb=AVTB,setpts=(PTS-${offset.toFixed(6)}/TB)/${speed}+${phase.toFixed(6)}/TB,fps=fps=${sourceMeta.fps}:start_time=0,tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=PTS-STARTPTS,scale=${targetDims.w}:${targetDims.h}:force_original_aspect_ratio=decrease,pad=${targetDims.w}:${targetDims.h}:(ow-iw)/2:(oh-ih)/2:color=#02040A,setsar=1,format=yuv420p[v${i}]`);
        concatInputs.push(`[v${i}]`);
      }

      if (!includeAudio || untouchedAudio) {
        // The original stream is mapped directly after the video filters.
      } else if (sourceHasAudio && sourceMeta.hasAudio && !state.audio.muted && !seg.muted && state.trackVisibility.audio) {
        const vol = Math.max(0, Math.min(2, seg.volume * state.audio.masterVolume));
        const denoise = state.audio.noiseReduction ? 'highpass=f=85,lowpass=f=11000,' : '';
        filterLines.push(
          `[${i}:a:${safeAudioIdx}]aresample=${rate}:async=1:first_pts=0,apad,atrim=start=${offset.toFixed(6)}:end=${(sEnd-seekStart).toFixed(6)},asetpts=PTS-STARTPTS,${speed===1 ? '' : buildAtempoChain(speed)+','}${denoise}volume=${vol.toFixed(4)},apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a${i}]`,
        );
      } else {
        filterLines.push(
          `anullsrc=r=${rate}:cl=${layout},atrim=end_sample=${samples}[a${i}]`,
        );
      }

    });

    if (!copyVideo) filterLines.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0,setpts=N/(${sourceMeta.fps}*TB)[vcat]`);

    let currentV = copyVideo?'0:v:0':'[vcat]';
    if (includeAudio && !untouchedAudio) filterLines.push(segments.map((_,i)=>`[a${i}]`).join('')+`concat=n=${segments.length}:v=0:a=1[acat]`);
    let currentA = untouchedAudio ? `0:a:${safeAudioIdx}` : '[acat]';

    // Apply timeline muteRanges and bleeps accurately onto concatenated audio
    const bleepWindows=state.audio.muted || !state.trackVisibility.audio ? [] : visibleIntervals(segments.filter(s=>!s.muted),state.bleeps);
    const muteWindows=visibleIntervals(segments,state.muteRanges || []).concat(bleepWindows);

    if (includeAudio && muteWindows.length > 0) {
      const enableExpr = muteWindows
        .map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`)
        .join('+');
      filterLines.push(
        `${currentA}asetnsamples=n=64:p=0,volume=enable='${enableExpr}':volume=0[amuted]`,
      );
      currentA = '[amuted]';
    }

    if (bleepWindows.length > 0) {
      const bleepEnableExpr = bleepWindows
        .map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`)
        .join('+');
      filterLines.push(
        `aevalsrc='0.28*sin(2*PI*1000*t)*gt(${bleepEnableExpr},0)':s=${rate}:d=${expectedDuration.toFixed(3)}[ableep]`,
      );
      filterLines.push(`${currentA}[ableep]amix=inputs=2:duration=first:normalize=0[awithbleep]`);
      currentA = '[awithbleep]';
    }

    // Labels are ASS document data, separate from FFmpeg's filter grammar.
    if ((state.captionsEnabled && state.trackVisibility.captions && state.captions.length) ||
        (state.trackVisibility.overlays && state.overlays.length)) {
      fs.writeFileSync(path.join(workDir,'titles.ass'), buildAssSubtitles(state, targetDims.w, targetDims.h), 'utf8');
      filterLines.push(`${currentV}ass=titles.ass[vsub]`);
      currentV = '[vsub]';
    }

    // Apply optional custom uploaded music or preset ambient music bed
    if (state.audio.musicEnabled && state.trackVisibility.music && !state.audio.muted) {
      const mVol = Math.max(0, Math.min(1, state.audio.musicVolume));
      const fadeIn = Math.max(0.05, state.audio.musicFadeInSec);
      const fadeOutDur = Math.max(0.1, state.audio.musicFadeOutSec);
      const fadeOutStart = Math.max(0.05, expectedDuration - fadeOutDur);
      const customUrl = state.audio.musicPreset === 'custom-upload' ? state.audio.customMusicUrl : undefined;
      const customName = customUrl
        ? path.basename(customUrl.split('?')[0])
        : '';
      let customPath = customName ? path.join(MUSIC_DIR, customName) : '';
      if ((!customPath || !fs.existsSync(customPath)) && customUrl?.startsWith('https://')) {
        downloadedMusicTempPath = path.join(TEMP_DIR, `bgm-${jobId}-${customName || 'track.mp3'}`);
        try {
          await downloadBlobToFile(customUrl, downloadedMusicTempPath);
          customPath = downloadedMusicTempPath;
        } catch {
          downloadedMusicTempPath = '';
        }
      }

      const musicInputIdx = segments.length;
      const startOffset = Math.max(0, state.audio.musicStartOffsetSec || 0);
      if (state.audio.musicPreset === 'custom-upload') {
        if (!customPath || !fs.existsSync(customPath)) throw new Error('The selected music file is unavailable.');
        inputArgs.push('-stream_loop', '-1', '-ss', startOffset.toFixed(6), '-i', customPath);
      } else {
        const pcm = musicLoop(state.audio.musicPreset);
        const raw = path.join(workDir, 'music.f32');
        fs.writeFileSync(raw, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        const offset = startOffset % (pcm.length / musicSampleRate);
        inputArgs.push('-stream_loop','-1','-f','f32le','-ar',String(musicSampleRate),'-ac','1','-ss',offset.toFixed(6),'-i',raw);
      }
      filterLines.push(
        `[${musicInputIdx}:a]atrim=duration=${expectedDuration.toFixed(6)},asetpts=PTS-STARTPTS,aformat=sample_rates=${rate}:channel_layouts=${layout},afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOutDur.toFixed(2)},volume=${mVol.toFixed(2)}[mbed]`,
      );
      if (state.audio.duckUnderSpeech!==false && sourceAudio && state.trackVisibility.audio) {
        filterLines.push(`${currentA}asplit=2[dialogue][key]`);
        filterLines.push('[mbed][key]sidechaincompress=threshold=0.025:ratio=8:attack=8:release=240[ducked]');
        filterLines.push('[dialogue][ducked]amix=inputs=2:duration=first:normalize=0[amix]');
      } else {
        filterLines.push(`${currentA}[mbed]amix=inputs=2:duration=first:normalize=0[amix]`);
      }
      currentA = '[amix]';
    }

    // Apply master audio fade in/out if configured
    if (includeAudio && (state.audio.fadeInSec > 0 || state.audio.fadeOutSec > 0)) {
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
    if (filterComplex) fs.writeFileSync(path.join(workDir,'filters.txt'),filterComplex);

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        ...inputArgs,
        ...(filterComplex ? ['-filter_complex_threads','2','-filter_complex_script','filters.txt'] : []),
        '-map', currentV,
        ...(includeAudio?['-map',currentA]:[]),
        ...(copyVideo?['-c:v','copy']:['-c:v','libx264','-threads:v','2','-r',String(sourceMeta.fps),'-preset',preset,'-crf',crf]),
        ...(includeAudio?(copyAudio ? ['-c:a','copy'] : ['-c:a','aac','-b:a',sourceAudio && sourceAudio.channels>2?'384k':'192k']):['-an']),
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        outPath,
      ];

      const proc = spawn('ffmpeg', args, {cwd:workDir});
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
        stderrLog = (stderrLog+chunk.toString()).slice(-4096);
      });

      proc.on('error',reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg render exited with code ${code}: ${stderrLog.slice(-400)}`));
      });
    });

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
    if (Math.abs(probed.durationSec-expectedDuration)>frameSec+0.001) {
      throw new Error(`Export length ${probed.durationSec}s differs from timeline ${expectedDuration}s by more than a frame.`);
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
  } finally {
    if (workDir) {
      for (const file of ['titles.ass','filters.txt','music.f32']) fs.rmSync(path.join(workDir,file),{force:true});
      fs.rmdirSync(workDir);
    }
    if (downloadedMusicTempPath) fs.rmSync(downloadedMusicTempPath,{force:true});
  }
}
