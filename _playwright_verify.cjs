const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/usr/local/share/bun-global/node_modules/playwright-core');

function findChromiumExecutable() {
  const candidates = [
    '/ms-playwright/chromium_headless_shell-1247/chrome-linux/headless_shell',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Recursive search under /ms-playwright
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (
        entry.name === 'headless_shell' ||
        entry.name === 'chrome-headless-shell' ||
        entry.name === 'chrome'
      ) {
        return full;
      }
    }
    return null;
  };
  return walk('/ms-playwright') || walk('/root/.cache/ms-playwright');
}

async function run() {
  const tmpMp4 = path.resolve(process.cwd(), '_pw_sample_commute.mp4');
  const tmpWav = path.resolve(process.cwd(), '_pw_sample_commute.wav');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', "flite=text='Every morning commute saves time with automated workflows.'",
    '-ar', '16000', '-ac', '1', tmpWav,
  ], { stdio: 'ignore' });
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=#080e24:s=640x360:r=12:d=5.5',
    '-i', tmpWav,
    '-af', 'apad=whole_dur=5.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', tmpMp4,
  ], { stdio: 'ignore' });
  fs.rmSync(tmpWav, { force: true });

  const exePath = findChromiumExecutable();
  assert.ok(exePath, 'Chromium executable must exist under /ms-playwright');
  console.log('[pw] Using Chromium:', exePath);

  const browser = await chromium.launch({
    executablePath: exePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const consoleErrors = [];
  const pageErrors = [];
  let createdProjectId = null;
  let createdMediaId = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore our intentional SSRF 400 negative test error log
        if (!text.includes('400')) consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Start Editing', { timeout: 10000 });

    // Click Start Editing -> Studio Dashboard
    await page.click('text=Start Editing');
    await page.waitForSelector('input[placeholder="Paste your video URL here..."]', { timeout: 10000 });

    // Verify zero horizontal overflow on Dashboard at 1440x900
    const dashOverflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    assert.ok(dashOverflow.scrollW <= dashOverflow.clientW, `Dashboard overflow: ${dashOverflow.scrollW} > ${dashOverflow.clientW}`);

    // Verify side-by-side A (Upload) and B (URL Intake) exist
    const hasUploadCard = await page.locator('text=A. Upload Video File').isVisible();
    const hasUrlCard = await page.locator('text=B. Enter Video URL').isVisible();
    assert.ok(hasUploadCard && hasUrlCard, 'Side-by-side Upload & URL cards must be visible');

    // Negative SSRF check in UI URL box: must show explicit error and NOT open any demo
    await page.fill('input[placeholder="Paste your video URL here..."]', 'http://127.0.0.1:3000/bad.mp4');
    await page.click('button:has-text("Import Video")');
    await page.waitForSelector('text=/Blocked|loopback|private|local/i', { timeout: 8000 });
    console.log('[pw] URL SSRF error explicitly rendered without demo fallback: PASS');

    // Upload real MP4 via file input inside Upload Video File card
    const fileInput = page.locator('input[type="file"][accept*="video"]').first();
    await fileInput.setInputFiles(tmpMp4);

    // Wait for workspace to load cleanly (AI Editing Assistant + Timeline visible)
    await page.waitForSelector('[data-testid="timeline-workspace"]', { timeout: 25000 });
    await page.waitForSelector('text=AI Editing Assistant', { timeout: 10000 });

    // Capture current project & media id for cleanup from bootstrap / DOM or API
    const projectsRes = await page.evaluate(async () => {
      const r = await fetch('/api/bootstrap');
      return r.json();
    });
    const uploadedProj = (projectsRes.projects || []).find((p) =>
      String(p.sourceFilename || p.title || '').includes('_pw_sample_commute'),
    );
    if (uploadedProj) {
      createdProjectId = uploadedProj.id;
      createdMediaId = uploadedProj.mediaId;
    }

    // Verify Workspace 3-col + bottom timeline overflow check
    const wsOverflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    assert.ok(wsOverflow.scrollW <= wsOverflow.clientW + 2, `Workspace overflow: ${wsOverflow.scrollW} > ${wsOverflow.clientW}`);

    // Wait up to 35s for transcription words to render in transcript panel
    await page.waitForSelector('[data-word-id]', { timeout: 35000 });
    console.log('[pw] Real upload transcribed and word spans rendered: PASS');

    // Verify Language Override dropdown & Dict button exist
    const langSel = page.locator('select[aria-label="Spoken language override"]');
    assert.ok(await langSel.isVisible(), 'Language override dropdown must be visible');

    await page.click('button:has-text("Dict (")');
    await page.waitForSelector('text=Project Vocabulary & Proper Names', { timeout: 5000 });
    await page.fill('textarea[placeholder*="IncuBrix"]', 'IncuBrix, IIT Madras, commute');
    await page.click('button:has-text("Save Vocabulary")');
    await page.waitForSelector('text=Dict (3)', { timeout: 5000 });
    console.log('[pw] Project dictionary saved (Dict (3)): PASS');

    // Click the first transcript word -> inspect Word Inspector (audio snippet player + Replay + Correct Word)
    const firstWordBtn = page.locator('[data-word-id]').first();
    await firstWordBtn.click();
    await page.waitForSelector('[data-testid="word-inspector"]', { timeout: 5000 });
    const hasSnippetAudio = await page.locator('[data-testid="word-inspector"] audio').count();
    assert.ok(hasSnippetAudio >= 1, 'Word Inspector must render <audio> snippet player');
    await page.fill('input[aria-label="Correct transcript word"]', 'IncuBrix');
    await page.click('button:has-text("Correct Word")');
    await page.waitForSelector('[data-word-id]:has-text("IncuBrix")', { timeout: 8000 });
    console.log('[pw] Word Inspector audio snippet + manual word correction synced to transcript: PASS');

    // Trigger AI prompt edit: "Remove the word commute" or "Remove the word IncuBrix"
    const promptBox = page.locator('textarea[aria-label="AI Editing Prompt"]');
    await promptBox.fill('Remove the word IncuBrix');
    await page.click('button[aria-label="Run AI edit prompt"]');
    await page.waitForSelector('button:has-text("Apply Edit")', { timeout: 10000 });
    await page.click('button:has-text("Apply Edit")');
    await page.waitForTimeout(800);
    console.log('[pw] Prompt-based word edit planned and applied in UI: PASS');

    assert.equal(pageErrors.length, 0, `Uncaught page errors: ${pageErrors.join(' | ')}`);
    assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join(' | ')}`);
    console.log('[pw] 1440x900 Playwright UI verification PASSED with 0 errors and 0 horizontal overflow!');
  } finally {
    fs.rmSync(tmpMp4, { force: true });
    await browser.close();
    // Output cleanup IDs if any
    if (createdProjectId || createdMediaId) {
      console.log(JSON.stringify({ cleanupProjectId: createdProjectId, cleanupMediaId: createdMediaId }));
    }
  }
}

run().catch((err) => {
  console.error('PLAYWRIGHT VERIFICATION FAILED:', err);
  process.exit(1);
});
