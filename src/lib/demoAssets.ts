import demoKeynoteThumb from '../assets/images/demo_keynote_bg_1795193518740.jpg';
import demoPodcastThumb from '../assets/images/demo_podcast_bg_1795193519906.jpg';
import demoTutorialThumb from '../assets/images/demo_tutorial_bg_1795193519231.jpg';
import demoTravelThumb from '../assets/images/demo_travel_bg_1795193519336.jpg';
import demoMarketingThumb from '../assets/images/demo_marketing_bg_1795193520022.jpg';

export const DEMO_BUNDLED_THUMBS: Record<string, string> = {
  'demo-keynote': demoKeynoteThumb,
  'demo-podcast': demoPodcastThumb,
  'demo-tutorial': demoTutorialThumb,
  'demo-travel': demoTravelThumb,
  'demo-marketing': demoMarketingThumb,
};

export function getBundledThumbForDemo(demoId?: string): string {
  if (!demoId) return demoKeynoteThumb;
  return DEMO_BUNDLED_THUMBS[demoId] || demoKeynoteThumb;
}

export interface CanvasFrameOptions {
  width: number;
  height: number;
  image?: HTMLImageElement | null;
  sourceTime: number;
  duration: number;
  topic?: string;
  speaker?: string;
  isPlaying?: boolean;
  captionText?: string;
  captionColor?: string;
  opacity?: number;
}

/**
 * Renders a deterministic, high-resolution animated Ken Burns video frame onto a 2D canvas.
 * Used both as a fallback video compositor in static/frontend-only deployments and for
 * browser-side WebM export when no remote FFmpeg backend is attached.
 */
export function renderDemoCanvasFrame(
  ctx: CanvasRenderingContext2D,
  opts: CanvasFrameOptions,
): void {
  const { width, height, image, sourceTime, topic, speaker, isPlaying, captionText, captionColor, opacity = 1 } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // Studio backdrop gradient (never flat dead void even before image finishes decoding)
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#070B1A');
  bg.addColorStop(0.55, '#0F172E');
  bg.addColorStop(1, '#140C29');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.globalAlpha = Math.max(0.08, Math.min(1, opacity));

  if (image && image.complete && image.naturalWidth > 0) {
    // Subtle smooth Ken Burns pan + slow breathe zoom synced to sourceTime
    const scaleBase = 1.07 + 0.03 * Math.sin(sourceTime * 0.45);
    const imgRatio = image.naturalWidth / image.naturalHeight;
    const targetRatio = width / height;

    let drawW = width * scaleBase;
    let drawH = drawW / imgRatio;
    if (imgRatio < targetRatio) {
      drawH = height * scaleBase;
      drawW = drawH * imgRatio;
    }

    const overflowX = Math.max(0, drawW - width);
    const overflowY = Math.max(0, drawH - height);
    const panX = Math.sin(sourceTime * 0.38) * (overflowX * 0.42);
    const panY = Math.cos(sourceTime * 0.27) * (overflowY * 0.42);

    const dx = (width - drawW) / 2 + panX;
    const dy = (height - drawH) / 2 + panY;
    ctx.drawImage(image, dx, dy, drawW, drawH);
  }

  // Cinematic edge vignette for contrast
  const vig = ctx.createRadialGradient(
    width * 0.5,
    height * 0.48,
    width * 0.18,
    width * 0.5,
    height * 0.5,
    width * 0.72,
  );
  vig.addColorStop(0, 'rgba(5, 7, 17, 0.05)');
  vig.addColorStop(1, 'rgba(5, 7, 17, 0.56)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, width, height);

  // Top-left chapter & speaker badge (mirrors backend ffmpeg drawtext layout)
  if (topic || speaker) {
    const labelText = [topic, speaker].filter(Boolean).join('  |  ');
    const padX = Math.max(12, Math.round(width * 0.016));
    const padY = Math.max(8, Math.round(height * 0.015));
    const fontPx = Math.max(12, Math.round(height * 0.028));
    ctx.font = `600 ${fontPx}px "Plus Jakarta Sans", Inter, system-ui, sans-serif`;
    const metrics = ctx.measureText(labelText);
    const boxW = Math.min(width - 40, metrics.width + padX * 2);
    const boxH = fontPx + padY * 1.4;
    const bx = Math.round(width * 0.028);
    const by = Math.round(height * 0.044);

    ctx.fillStyle = 'rgba(5, 7, 17, 0.68)';
    roundRectPath(ctx, bx, by, boxW, boxH, 8);
    ctx.fill();

    ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#F8FAFC';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, bx + padX, by + boxH / 2 + 0.5, boxW - padX * 2);
  }

  // Subtle animated waveform visualizer bar in bottom-right when playing
  if (isPlaying) {
    const barCount = 14;
    const barW = Math.max(3, Math.round(width * 0.004));
    const gap = Math.max(2, Math.round(width * 0.003));
    const baseRight = width - Math.round(width * 0.03);
    const baseBottom = height - Math.round(height * 0.045);

    for (let i = 0; i < barCount; i++) {
      const wave = Math.abs(Math.sin(sourceTime * 7.5 + i * 0.65));
      const h = Math.round(height * (0.015 + wave * 0.035));
      const x = baseRight - (barCount - i) * (barW + gap);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(34, 211, 238, 0.8)' : 'rgba(167, 139, 250, 0.8)';
      roundRectPath(ctx, x, baseBottom - h, barW, h, 2);
      ctx.fill();
    }
  }

  // Optional burned-in caption (used during canvas WebM export)
  if (captionText && captionText.trim()) {
    const fontPx = Math.max(15, Math.round(height * 0.034));
    ctx.font = `600 ${fontPx}px "Plus Jakarta Sans", Inter, system-ui, sans-serif`;
    const maxW = width * 0.84;
    const words = captionText.trim().split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (ctx.measureText(test).width > maxW && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    const lineHeight = fontPx * 1.32;
    const blockH = lines.length * lineHeight + 16;
    const blockW = Math.min(
      maxW + 28,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28,
    );
    const bx = (width - blockW) / 2;
    const by = height - blockH - Math.round(height * 0.065);

    ctx.fillStyle = 'rgba(5, 7, 17, 0.82)';
    roundRectPath(ctx, bx, by, blockW, blockH, 10);
    ctx.fill();

    ctx.fillStyle = captionColor || '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, idx) => {
      ctx.fillText(line, width / 2, by + 10 + (idx + 0.5) * lineHeight);
    });
  }

  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
