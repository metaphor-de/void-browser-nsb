// =====================================================================
// 📦 دانلود خودکار ابزارهای خارجی (ffmpeg، yt-dlp، whisper و مدل)
// در اولین اجرای برنامه این ابزارها را می‌گیرد تا نصب‌کننده سبک بماند
// این ماژول مستقل از Electron است و با Node خالص هم قابل تست است
// =====================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URLS = {
  ffmpegZip: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  ffmpegZipAlt: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  whisperZip: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
};

// مدل پیش‌فرض برای دانلود خودکار (181MB — تعادل خوب بین کیفیت و حجم)
// چند سرور — اگر اولی در دسترس نبود (فیلتر/قطعی)، از آینه جایگزین گرفته می‌شود
const WHISPER_MODEL_NAME = 'ggml-small-q5_1.bin';
const WHISPER_MODEL_URLS = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
];

// در بسته whisper فقط این‌ها لازم است — بقیه ابزار تست/دستیار هستند
const WHISPER_EXCLUDE = [
  'test-*.exe', 'bench.exe', 'command.exe', 'main.exe', 'stream.exe',
  'parakeet*', 'wchess.exe', 'whisper-bench.exe', 'whisper-command.exe',
  'whisper-lsp.exe', 'whisper-quantize.exe', 'whisper-stream.exe',
  'whisper-talk-llama.exe', 'whisper-vad-speech-segments.exe',
];

function fsExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// جستجوی عمیق یک فایل در پوشه (BFS)
function findDeep(rootDir, fileName) {
  const queue = [rootDir];
  while (queue.length) {
    const dir = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.name.toLowerCase() === fileName.toLowerCase()) return full;
    }
  }
  return null;
}

// دانلود استریمی با تلاش مجدد خودکار و گزارش پیشرفت
const delay = ms => new Promise(r => setTimeout(r, ms));

async function downloadFile(fetchFn, url, dest, onProgress, attempt = 1) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`خطای HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length') || 0);
    let loaded = 0;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      out.on('error', reject);
      (async () => {
        try {
          const body = res.body;
          if (body && typeof body.getReader === 'function') {
            // Web ReadableStream (الکترون net.fetch) — از پروکسی/VPN سیستم پیروی می‌کند
            const reader = body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
              loaded += value.byteLength;
              if (onProgress) onProgress(loaded, total);
            }
          } else {
            for await (const chunk of body) {
              if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
              loaded += chunk.length;
              if (onProgress) onProgress(loaded, total);
            }
          }
          out.end(resolve);
        } catch (e) { reject(e); }
      })();
    });

    if (!fsExists(dest) || fs.statSync(dest).size === 0) throw new Error('فایل دانلودشده خالی است');
    return dest;
  } catch (e) {
    // تا ۳ بار تلاش مجدد با فاصله — نوسان اینترنت را پوشش می‌دهد
    if (attempt < 3) {
      await delay(1500 * attempt);
      return downloadFile(fetchFn, url, dest, onProgress, attempt + 1);
    }
    let host = url;
    try { host = new URL(url).host; } catch {}
    throw new Error(`عدم دسترسی به ${host} (${e.message}) — اینترنت یا VPN را بررسی کنید`);
  }
}

// باز کردن زیپ با PowerShell (همیشه در ویندوز موجود است)
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const cmd = `Expand-Archive -LiteralPath "${zipPath.replace(/"/g, '`"')}" -DestinationPath "${destDir.replace(/"/g, '`"')}" -Force`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', () => reject(new Error('PowerShell در دسترس نیست')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`خطا در باز کردن زیپ: ${stderr.slice(-300)}`)));
  });
}

// کپی فایل‌های لازم whisper با احترام به الگوی Exclude
function copyWhisperFiles(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const matches = (name, pattern) => {
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      return re.test(name);
    }
    return name.toLowerCase() === pattern.toLowerCase();
  };
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir)) {
    if (WHISPER_EXCLUDE.some(pat => matches(entry, pat))) continue;
    const src = path.join(srcDir, entry);
    if (fs.statSync(src).isFile()) { fs.copyFileSync(src, path.join(destDir, entry)); copied++; }
  }
  return copied;
}

/**
 * بررسی و دانلود خودکار همه ابزارها در toolsRoot
 * گزینه‌ها: { toolsRoot, skip: ['ffmpeg','ytdlp','whisper','model'], onItem(item, state), onProgress(item, percent) }
 */
async function ensureTools(options) {
  const { toolsRoot, skip = [], fetchImpl, onItem = () => {}, onProgress = () => {}, log = () => {} } = options || {};
  const skipSet = new Set(skip);
  const skipped = item => skipSet.has(item);
  // در اپ الکترون net.fetch تزریق می‌شود (از پروکسی/VPN سیستم پیروی می‌کند)
  const fetchFn = fetchImpl || globalThis.fetch;
  const dl = (url, dest, onProg) => downloadFile(fetchFn, url, dest, onProg);
  fs.mkdirSync(toolsRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'void-tools-'));

  const ffmpegPath = path.join(toolsRoot, 'ffmpeg.exe');
  const ffprobePath = path.join(toolsRoot, 'ffprobe.exe');
  const ytdlpPath = path.join(toolsRoot, 'yt-dlp.exe');
  const whisperDir = path.join(toolsRoot, 'whisper_resources');
  const whisperCli = path.join(whisperDir, 'whisper-cli.exe');
  const modelPath = path.join(whisperDir, WHISPER_MODEL_NAME);

  // ---------- 1) ffmpeg + ffprobe ----------
  if (skipped('ffmpeg')) {
    onItem('ffmpeg', 'ready');
  } else if (fsExists(ffmpegPath) && fsExists(ffprobePath)) {
    onItem('ffmpeg', 'ready');
  } else {
    onItem('ffmpeg', 'downloading');
    let zipPath = path.join(tmp, 'ffmpeg.zip');
    let downloaded = false;
    for (const url of [URLS.ffmpegZip, URLS.ffmpegZipAlt]) {
      try {
        await dl(url, zipPath, (l, t) => onProgress('ffmpeg', t ? Math.round(l / t * 100) : 0));
        downloaded = true; break;
      } catch (e) { log(`ffmpeg از ${url} ناموفق: ${e.message}`); }
    }
    if (!downloaded) throw new Error('دانلود ffmpeg ناموفق بود — اتصال اینترنت (یا VPN) را بررسی کنید');

    onItem('ffmpeg', 'extracting');
    const exDir = path.join(tmp, 'ffmpeg-ex');
    await extractZip(zipPath, exDir);
    const found = findDeep(exDir, 'ffmpeg.exe');
    if (!found) throw new Error('ffmpeg.exe داخل بسته پیدا نشد');
    fs.copyFileSync(found, ffmpegPath);
    fs.copyFileSync(path.join(path.dirname(found), 'ffprobe.exe'), ffprobePath);
    onItem('ffmpeg', 'ready');
  }

  // ---------- 2) yt-dlp ----------
  if (skipped('ytdlp') || fsExists(ytdlpPath)) {
    onItem('ytdlp', 'ready');
  } else {
    onItem('ytdlp', 'downloading');
    await dl(URLS.ytdlp, ytdlpPath, (l, t) => onProgress('ytdlp', t ? Math.round(l / t * 100) : 0));
    onItem('ytdlp', 'ready');
  }

  // ---------- 3) whisper.cpp ----------
  if (skipped('whisper') || fsExists(whisperCli)) {
    onItem('whisper', 'ready');
  } else {
    onItem('whisper', 'downloading');
    const zipPath = path.join(tmp, 'whisper.zip');
    await dl(URLS.whisperZip, zipPath, (l, t) => onProgress('whisper', t ? Math.round(l / t * 100) : 0));
    onItem('whisper', 'extracting');
    const exDir = path.join(tmp, 'whisper-ex');
    await extractZip(zipPath, exDir);
    const found = findDeep(exDir, 'whisper-cli.exe');
    if (!found) throw new Error('whisper-cli.exe داخل بسته پیدا نشد');
    const n = copyWhisperFiles(path.dirname(found), whisperDir);
    log(`${n} فایل whisper کپی شد`);
    onItem('whisper', 'ready');
  }

  // ---------- 4) مدل whisper ----------
  if (skipped('model') || fsExists(modelPath)) {
    onItem('model', 'ready');
  } else {
    onItem('model', 'downloading');
    const partPath = modelPath + '.part';
    // چند سرور برای مدل — اگر HuggingFace در دسترس نبود از آینه جایگزین گرفته می‌شود
    let modelDone = false;
    let lastErr = null;
    for (const url of WHISPER_MODEL_URLS) {
      try {
        await dl(url, partPath, (l, t) => onProgress('model', t ? Math.round(l / t * 100) : 0));
        modelDone = true; break;
      } catch (e) { lastErr = e; log(`مدل از ${url} ناموفق: ${e.message}`); }
    }
    if (!modelDone) throw lastErr || new Error('دانلود مدل ناموفق بود');
    fs.renameSync(partPath, modelPath);
    onItem('model', 'ready');
  }

  // پاک‌سازی فایل‌های موقت
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  return {
    ffmpeg: fsExists(ffmpegPath),
    ffprobe: fsExists(ffprobePath),
    ytdlp: fsExists(ytdlpPath),
    whisper: fsExists(whisperCli),
    model: fsExists(modelPath),
    modelPath,
  };
}

// بررسی سریع اینکه همه ابزارها حاضرند یا نه (بدون دانلود)
function checkTools(toolsRoot) {
  const whisperDir = path.join(toolsRoot, 'whisper_resources');
  return {
    ffmpeg: fsExists(path.join(toolsRoot, 'ffmpeg.exe')),
    ffprobe: fsExists(path.join(toolsRoot, 'ffprobe.exe')),
    ytdlp: fsExists(path.join(toolsRoot, 'yt-dlp.exe')),
    whisper: fsExists(path.join(whisperDir, 'whisper-cli.exe')),
    model: fsExists(path.join(whisperDir, WHISPER_MODEL_NAME)),
  };
}

module.exports = { ensureTools, checkTools, WHISPER_MODEL_NAME, WHISPER_MODEL_URLS, URLS };
