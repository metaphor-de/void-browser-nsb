const { app, BrowserWindow, session, ipcMain, Menu, MenuItem, clipboard, net } = require('electron');
const { runDubPipeline, activeJobs } = require('./dub-pipeline');
const { ensureTools, WHISPER_MODEL_NAME } = require('./tools-setup');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 🦙 تنظیمات سرور لوکال اولاما
const OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_TEXT_MODEL = 'qwen2.5:3b';
const VISION_MODEL = 'llava:latest';

let isSettingUpServer = false;

// =====================================================================
// 🧰 مسیریابی ابزارها: اول پوشه پروژه (dev)، بعد resources، بعد tools
// (پوشه tools به صورت خودکار در اولین اجرا با دانلود پر می‌شود)
// =====================================================================
function getToolsRoots() {
  const roots = [];
  if (!app.isPackaged) roots.push(__dirname);
  roots.push(process.resourcesPath);
  roots.push(path.join(app.getPath('userData'), 'tools'));
  return roots;
}

function findToolFile(...segments) {
  for (const root of getToolsRoots()) {
    const p = path.join(root, ...segments);
    if (fs.existsSync(p)) return p;
  }
  // مسیر پیش‌فرض (مقصد دانلود خودکار) — آخرین ریشه
  const roots = getToolsRoots();
  return path.join(roots[roots.length - 1], ...segments);
}

function getToolPaths() {
  const ytdlp = findToolFile('yt-dlp.exe');
  const ffmpeg = findToolFile('ffmpeg.exe');
  return { ytdlp, ffmpegDir: path.dirname(ffmpeg) };
}

// مدل‌های پشتیبانی‌شده whisper — اولین مدل موجود استفاده می‌شود
const WHISPER_MODELS = ['ggml-small.bin', 'ggml-small-q5_1.bin', 'ggml-base.bin', 'ggml-base-q5_1.bin'];

function getDubPaths() {
  const whisperDir = path.dirname(findToolFile('whisper_resources', 'whisper-cli.exe'));
  const whisperModelPath = WHISPER_MODELS
    .map(m => path.join(whisperDir, m))
    .find(p => fs.existsSync(p)) || path.join(whisperDir, WHISPER_MODEL_NAME);
  return { 
    ytdlp: findToolFile('yt-dlp.exe'), 
    ffmpeg: findToolFile('ffmpeg.exe'), 
    ffprobe: findToolFile('ffprobe.exe'), 
    whisperCli: findToolFile('whisper_resources', 'whisper-cli.exe'), 
    whisperModelPath, 
    downloadsDir: app.getPath('downloads') 
  };
}

// =====================================================================
// 📦 دانلود خودکار ابزارها در اولین اجرا (ffmpeg، yt-dlp، whisper، مدل)
// =====================================================================
let toolsSetupPromise = null;
let toolsState = { running: false, done: false, error: null, items: {} };

function sendToolsUpdate(data) {
  try { mainWindow?.webContents?.send('tools-progress', data); } catch {}
}

// بررسی اینکه هر ابزار در ریشه‌های موجود (پروژه/resources) هست یا نه
function findAvailableTools() {
  const roots = getToolsRoots().slice(0, -1); // ریشه tools (مقصد دانلود) را نادیده بگیر
  const avail = { ffmpeg: false, ytdlp: false, whisper: false, model: false };
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'ffmpeg.exe')) && fs.existsSync(path.join(root, 'ffprobe.exe'))) avail.ffmpeg = true;
    if (fs.existsSync(path.join(root, 'yt-dlp.exe'))) avail.ytdlp = true;
    const wdir = path.join(root, 'whisper_resources');
    if (fs.existsSync(path.join(wdir, 'whisper-cli.exe'))) avail.whisper = true;
    if (WHISPER_MODELS.some(m => fs.existsSync(path.join(wdir, m)))) avail.model = true;
  }
  return avail;
}

function startToolsSetup() {
  if (toolsSetupPromise) return toolsSetupPromise;
  const toolsRoot = path.join(app.getPath('userData'), 'tools');

  // ابزارهایی که از قبل در پوشه برنامه موجودند نیازی به دانلود ندارند
  const avail = findAvailableTools();
  const skip = Object.keys(avail).filter(k => avail[k]);

  if (skip.length === 4) {
    toolsState = { running: false, done: true, error: null, items: { ffmpeg: 'ready', ytdlp: 'ready', whisper: 'ready', model: 'ready' } };
    return Promise.resolve();
  }

  toolsState = { running: true, done: false, error: null, items: {} };
  const NAMES = { ffmpeg: 'ffmpeg (پردازش ویدیو)', ytdlp: 'yt-dlp (دانلود ویدیو)', whisper: 'whisper (تشخیص گفتار)', model: 'مدل هوش مصنوعی whisper' };

  toolsSetupPromise = ensureTools({
    toolsRoot,
    skip,
    // net.fetch از پروکسی/VPN سیستم پیروی می‌کند — fetch خام Node این کار را نمی‌کند
    fetchImpl: (typeof net?.fetch === 'function') ? (url) => net.fetch(url) : undefined,
    log: (...a) => console.log('[tools-setup]', ...a),
    onItem: (item, state) => {
      toolsState.items[item] = state;
      if (state === 'downloading') sendToolsUpdate({ item, state, message: `در حال دانلود ${NAMES[item]}...` });
      if (state === 'extracting') sendToolsUpdate({ item, state, message: `در حال نصب ${NAMES[item]}...` });
      if (state === 'ready') sendToolsUpdate({ item, state: 'done', message: `${NAMES[item]} آماده شد` });
    },
    onProgress: (item, percent) => sendToolsUpdate({ item, state: 'downloading', percent, message: `دانلود ${NAMES[item]} — ${percent}%` }),
  }).then(result => {
    toolsState = { running: false, done: true, error: null, items: toolsState.items, result };
    sendToolsUpdate({ item: 'all', state: 'done', message: 'همه ابزارها آماده شدند ✓' });
  }).catch(err => {
    toolsState = { running: false, done: false, error: err.message, items: toolsState.items };
    sendToolsUpdate({ item: 'all', state: 'error', message: `خطا در دانلود ابزارها: ${err.message}` });
    console.error('[tools-setup]', err);
  });

  return toolsSetupPromise;
}

async function waitForTools(sender) {
  if (!toolsSetupPromise) return;
  if (!toolsState.running) return;
  sender?.send('tools-progress', { item: 'wait', state: 'downloading', message: 'در حال آماده‌سازی ابزارها (فقط بار اول) — لطفاً چند لحظه صبر کنید...' });
  await toolsSetupPromise.catch(() => {});
}

ipcMain.handle('get-tools-status', () => toolsState);

// تلاش مجدد برای دانلود ابزارها (بعد از رفع مشکل اینترنت/VPN)
ipcMain.handle('retry-tools-setup', async () => {
  toolsSetupPromise = null;
  toolsState = { running: false, done: false, error: null, items: {} };
  const p = startToolsSetup();
  return { started: true };
});

function createWindow() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'x-frame-options') delete headers[key];
    }
    callback({ cancel: false, responseHeaders: headers });
  });

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, title: 'VOID Browser', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
  });
  mainWindow.loadFile('index.html');
}

app.on('web-contents-created', (event, contents) => {
  contents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (params.selectionText) {
      menu.append(new MenuItem({ label: 'کپی', role: 'copy' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ 
        label: `جستجو در گوگل`, 
        click: () => mainWindow.webContents.send('open-new-tab', `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`) 
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) menu.append(new MenuItem({ label: 'جای‌گذاری', role: 'paste' }));
    if (params.hasImageContents && params.srcURL) {
      menu.append(new MenuItem({ label: '🤖 تحلیل عکس با هوش مصنوعی', click: () => mainWindow.webContents.send('analyze-image', params.srcURL) }));
      menu.append(new MenuItem({ label: 'کپی آدرس تصویر', click: () => clipboard.writeText(params.srcURL) }));
    }
    if (!params.selectionText && !params.isEditable && !params.linkURL && !params.hasImageContents) {
      menu.append(new MenuItem({ label: 'بازگشت', role: 'back' }));
      menu.append(new MenuItem({ label: 'جلو', role: 'forward' }));
      menu.append(new MenuItem({ label: 'بارگذاری مجدد', role: 'reload' }));
    }
    if (menu.items.length > 0) menu.popup();
  });
});

// =====================================================================
// 🚀 بررسی خودکار سلامت سرور اولاما
// =====================================================================
async function isServerRunning() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function findOllamaExecutable() {
  const localApp = process.env.LOCALAPPDATA || '';
  const progFiles = process.env.ProgramFiles || '';
  const paths = [
    path.join(localApp, 'Programs', 'Ollama', 'ollama.exe'),
    path.join(localApp, 'Programs', 'Ollama', 'ollama app.exe'),
    path.join(progFiles, 'Ollama', 'ollama.exe')
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureLocalAiServer(sender) {
  if (await isServerRunning()) return true;
  if (isSettingUpServer) return false;
  isSettingUpServer = true;

  try {
    const binary = findOllamaExecutable();
    if (binary) {
      sender?.send('ai-status', 'در حال راه‌اندازی سرور هوش مصنوعی در پس‌زمینه...');
      const srv = spawn(binary, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      srv.unref();

      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isServerRunning()) break;
      }
    }
    return await isServerRunning();
  } finally {
    isSettingUpServer = false;
  }
}

ipcMain.handle('check-ai-ready', async () => isServerRunning());

// =====================================================================
// 🌐 ابزارهای دسترسی به اینترنت زنده (وب، مقالات و کانال‌های یوتیوب)
// =====================================================================

// موتور جستجوی زنده وب
async function searchWeb(query) {
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: `q=${encodeURIComponent(query)}`
    });

    const html = await res.text();
    const results = [];
    const regex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="result-snippet">([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      let url = match[1];
      if (url.includes('uddg=')) {
        try { url = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('uddg') || url); } catch(e) {}
      }
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      const snippet = match[3].replace(/<[^>]+>/g, '').trim();
      results.push(`📌 عنوان: ${title}\n🔗 لینک: ${url}\n📝 خلاصه اطلاعات: ${snippet}`);
    }
    return results.length ? results.join('\n\n') : 'اطلاعاتی در وب پیدا نشد.';
  } catch (error) {
    return `خطا در جستجوی اینترنت: ${error.message}`;
  }
}

// ابزار خواندن مستقیم متن هر صفحه از اینترنت
async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(12000)
    });
    const html = await res.text();
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, 4000);
  } catch (err) {
    return `خطا در دریافت متن صفحه اینترنتی: ${err.message}`;
  }
}

// کشف آدرس دقیق کانال یوتیوب
async function resolveYoutubeChannelUrl(channelName) {
  const clean = channelName.trim().replace(/^@/, '');
  const lower = clean.toLowerCase();

  const aliases = {
    'mr beast': 'MrBeast',
    'mrbeast': 'MrBeast',
    'مستر بیست': 'MrBeast',
    'مستربیست': 'MrBeast',
    'pewdiepie': 'PewDiePie',
    'پودی پای': 'PewDiePie',
    'mia plays': 'MiaPlays',
    'میا پلیز': 'MiaPlays',
    'kourosh': 'KouroshZerox',
    'کوروش': 'KouroshZerox',
    'mkbhd': 'mkbhd',
    'دیجیاتو': 'Digiato',
    'زومیت': 'Zoomit'
  };

  if (aliases[lower]) return `https://www.youtube.com/@${aliases[lower]}`;
  if (/^[a-zA-Z0-9_.-]+$/.test(clean)) return `https://www.youtube.com/@${clean}`;

  try {
    const webRes = await searchWeb(`site:youtube.com/@ "${clean}"`);
    const m = webRes.match(/https:\/\/(?:www\.)?youtube\.com\/@([a-zA-Z0-9_.-]+)/i);
    if (m) return `https://www.youtube.com/@${m[1]}`;
  } catch {}

  return `https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}&sp=EgIQAg%253D%253D`;
}

// آخرین ویدیوی کانال یوتیوب
function findChannelLatestVideo(channelUrlOrName) {
  return new Promise(async (resolve) => {
    const { ytdlp } = getToolPaths();
    if (!fs.existsSync(ytdlp)) return resolve(null);

    let targetUrl = channelUrlOrName.startsWith('http') ? channelUrlOrName : await resolveYoutubeChannelUrl(channelUrlOrName);
    if (targetUrl.includes('@') && !targetUrl.endsWith('/videos')) {
      targetUrl = targetUrl.replace(/\/+$/, '') + '/videos';
    }

    const args = ['--no-playlist', '--playlist-end', '1', '--print', '%(webpage_url)s|||%(title)s|||%(uploader)s', targetUrl];
    const child = spawn(ytdlp, args, { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());

    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 20000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        const parts = stdout.trim().split('|||');
        resolve({ url: parts[0]?.trim(), title: parts[1]?.trim(), uploader: parts[2]?.trim() });
      } else {
        findDirectYoutubeVideo(`${channelUrlOrName} latest video`).then(resolve);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      findDirectYoutubeVideo(`${channelUrlOrName} latest video`).then(resolve);
    });
  });
}

function findDirectYoutubeVideo(query) {
  return new Promise((resolve) => {
    const { ytdlp } = getToolPaths();
    if (!fs.existsSync(ytdlp)) return resolve(null);

    const args = ['--no-playlist', '--playlist-end', '1', '--print', '%(webpage_url)s|||%(title)s|||%(uploader)s', `ytsearch1:${query}`];
    const child = spawn(ytdlp, args, { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());

    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        const parts = stdout.trim().split('|||');
        resolve({ url: parts[0]?.trim(), title: parts[1]?.trim(), uploader: parts[2]?.trim() });
      } else {
        resolve(null);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function callOllamaChat(model, messages, format = null, temperature = 0.1) {
  const body = {
    model: model || DEFAULT_TEXT_MODEL,
    messages: messages,
    stream: false,
    options: {
      temperature: temperature,
      num_predict: 1200
    }
  };
  if (format) body.format = format;

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`خطای سرور لوکال (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data?.message?.content || '';
}

// =====================================================================
// 🧠 ایجنت منطقی با دسترسی کامل به اینترنت زنده (Live Web Agent)
// =====================================================================
ipcMain.handle('ask-local-ai', async (_event, payload) => {
  const { messages, pageContext } = payload;
  const sender = _event.sender;
  const rawMsg = messages[messages.length - 1].content.trim();

  try {
    await ensureLocalAiServer(sender);
  } catch (err) {
    return `⚠️ ${err.message}`;
  }

  // ۱. بررسی عکس
  const imageUrlMatch = rawMsg.match(/(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|webp|gif))/i);
  if (imageUrlMatch) {
    sender.send('ai-status', 'در حال پردازش تصویر با مدل بینایی llava...');
    try {
      const imgRes = await fetch(imageUrlMatch[1]);
      const arrayBuffer = await imgRes.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString('base64');
      const visionPrompt = [
        {
          role: 'user',
          content: 'این تصویر را با جزئیات کامل و روان به زبان فارسی تحلیل کن و بگو چه چیزهایی دیده می‌شود:',
          images: [base64Image]
        }
      ];
      return await callOllamaChat(VISION_MODEL, visionPrompt);
    } catch (err) {
      return `⚠️ خطا در تحلیل تصویر: ${err.message}`;
    }
  }

  // تزریق زمان و تاریخ زنده به هوش مصنوعی
  const now = new Date();
  const currentDate = now.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  // ۲. تحلیل نیت کاربر با دسترسی به ابزارهای اینترنت زنده
  const systemAgentPrompt = `تو مغز متفکر و مجری هوشمند مرورگر VOID هستی که به اینترنت زنده (Live Web Search) دسترسی کامل داری.
امروز: ${currentDate}

اطلاعات صفحه فعال کاربر:
- عنوان: "${pageContext?.title || 'صفحه خالی'}"
- آدرس: "${pageContext?.url || 'ندارد'}"
- محتوا: ${pageContext?.content ? `"${pageContext.content.slice(0, 800)}"` : 'خالی'}

اکشن‌های مجاز:
1. "WEB_SEARCH": کاربر سوالی پرسیده که نیاز به اطلاعات زنده، اخبار جدید، قیمت‌ها، وقایع روز، اطلاعات علمی، تحقیق یا سرچ در وب و دانشنامه‌ها دارد. [target = عبارت بهینه‌شده برای جستجو در وب]
2. "READ_URL": کاربر می‌خواهد محتوای متنی یک لینک یا آدرس اینترنتی مشخص را بخواند و بررسی کند. [target = لینک معتبر کامل]
3. "OPEN_CHANNEL": کاربر می‌خواهد به کانال یک یوتیوبر برود. [target = نام کانال]
4. "YOUTUBE_LATEST": کاربر می‌خواهد آخرین ویدیوی یک کانال یوتیوب را ببیند. [target = نام کانال]
5. "YOUTUBE_PLAY": کاربر می‌خواهد یک ویدیو یا موسیقی مشخص را در یوتیوب پخش کند. [target = موضوع ویدیو]
6. "OPEN_URL": کاربر می‌خواهد به سایتی برود (مثال: برو تو یوتیوب، برو ویکی‌پدیا). [target = آدرس URL یا نام سایت]
7. "HIGHLIGHT": کاربر می‌خواهد کلمه یا عبارتی در همین صفحه جاری هایلایت شود. [target = کلمه مدنظر، بدون کلمات اضافه]
8. "SUMMARIZE_PAGE": کاربر می‌خواهد همین صفحه فعلی خلاصه شود. [target = ""]
9. "TRANSLATE_PAGE": کاربر می‌خواهد صفحه فعلی ترجمه شود. [target = "fa"]
10. "CHAT": فقط سلام و احوالپرسی یا مکالمه کوتاه و بدون نیاز به اینترنت. [target = ""]

خروجی الزاماً باید به صورت شیء JSON معتبر زیر باشد:
{
  "thought": "تحلیل نیت کاربر",
  "action": "یکی از اکشن‌های بالا",
  "target": "هدف استخراج شده متناسب با اکشن",
  "message": "پیام فارسی کوتاه به کاربر"
}`;

  sender.send('ai-status', 'در حال تحلیل هوشمند درخواست...');

  let decision = null;
  try {
    const rawDecision = await callOllamaChat(
      DEFAULT_TEXT_MODEL,
      [
        { role: 'system', content: systemAgentPrompt },
        { role: 'user', content: rawMsg }
      ],
      'json',
      0.1
    );
    decision = JSON.parse(rawDecision);
  } catch (e) {
    decision = { action: 'CHAT', message: '', target: '' };
  }

  const action = decision.action || 'CHAT';
  const target = (decision.target || '').trim();

  // ==========================================================
  // اجرای عملیات بر اساس اتصال به اینترنت:
  // ==========================================================

  // ۱. جستجو در اینترنت زنده و تولید پاسخ کامل
  if (action === 'WEB_SEARCH') {
    sender.send('ai-status', `در حال جستجو در اینترنت زنده برای "${target}"...`);
    const liveWebResults = await searchWeb(target);

    sender.send('ai-status', 'در حال پردازش نتایج زنده وب و نگارش پاسخ...');
    const synthesisPrompt = [
      {
        role: 'system',
        content: `تو دستیار متصل به اینترنت زنده در مرورگر VOID هستی.
اطلاعات زیر تازه‌ترین نتایج جستجو از اینترنت است:
"""
${liveWebResults}
"""
وظیفه تو: با اتکا به اطلاعات زنده بالا، پاسخی دقیق، جامع، روان و به زبان فارسی بنویس. در صورت وجود، لینک‌های مهم را نیز در انتهای پاسخ ذکر کن.`
      },
      {
        role: 'user',
        content: rawMsg
      }
    ];

    return await callOllamaChat(DEFAULT_TEXT_MODEL, synthesisPrompt, null, 0.3);
  }

  // ۲. بازخوانی مستقیم محتوای یک لینک از اینترنت
  if (action === 'READ_URL') {
    sender.send('ai-status', `در حال دانلود و خواندن صفحه "${target}"...`);
    const pageText = await fetchPageText(target);

    sender.send('ai-status', 'در حال خلاصه‌سازی و تحلیل محتوای سایت...');
    const readPrompt = [
      {
        role: 'system',
        content: `متن استخراج شده از صفحه اینترنتی:
"""
${pageText}
"""
وظیفه: این محتوا را دقیق بررسی کن و پاسخی جامع و مفید به زبان فارسی برای کاربر بنویس.`
      },
      {
        role: 'user',
        content: rawMsg
      }
    ];

    return await callOllamaChat(DEFAULT_TEXT_MODEL, readPrompt, null, 0.3);
  }

  // ۳. باز کردن کانال یوتیوب
  if (action === 'OPEN_CHANNEL') {
    sender.send('ai-status', `در حال پیدا کردن کانال "${target}" در یوتیوب...`);
    const channelUrl = await resolveYoutubeChannelUrl(target);
    return `ACTION: OPEN ${channelUrl}\nدر حال باز کردن کانال رسمی ${target} در یوتیوب...`;
  }

  // ۴. آخرین ویدیوی چنل یوتیوب
  if (action === 'YOUTUBE_LATEST') {
    sender.send('ai-status', `در حال استخراج آخرین ویدیوی رسمی کانال "${target}"...`);
    const video = await findChannelLatestVideo(target);
    if (video && video.url) {
      return `ACTION: OPEN ${video.url}\nدر حال پخش آخرین ویدیوی "${video.title}" از کانال ${video.uploader}...`;
    }
    return `متأسفانه ویدیویی برای کانال ${target} پیدا نشد.`;
  }

  // ۵. پخش ویدیو یوتیوب
  if (action === 'YOUTUBE_PLAY') {
    sender.send('ai-status', `در حال جستجوی ویدیو برای "${target}"...`);
    const video = await findDirectYoutubeVideo(target);
    if (video && video.url) {
      return `ACTION: OPEN ${video.url}\nدر حال پخش ویدیوی "${video.title}" از کانال ${video.uploader}...`;
    }
    return `ویدیویی برای "${target}" پیدا نشد.`;
  }

  // ۶. باز کردن آدرس یا سایت
  if (action === 'OPEN_URL') {
    let url = target;
    if (/ویکی\s*پدیا|wikipedia/i.test(target)) url = 'https://fa.wikipedia.org';
    else if (/یوتیوب|youtube/i.test(target)) url = 'https://www.youtube.com';
    else if (/گوگل|google/i.test(target)) url = 'https://www.google.com';
    else if (/گیت\s*هاب|github/i.test(target)) url = 'https://github.com';
    else if (!url.startsWith('http')) url = 'https://' + url.replace(/\s+/g, '');

    return `ACTION: OPEN ${url}\n${decision.message || 'در حال باز کردن سایت...'}`;
  }

  // ۷. هایلایت کلمه در صفحه
  if (action === 'HIGHLIGHT') {
    const cleanWord = target.replace(/["'«»]/g, '').trim();
    if (cleanWord) {
      return `ACTION: HIGHLIGHT ${cleanWord}\nکلمه "${cleanWord}" پیدا و با رنگ زرد در صفحه هایلایت شد.`;
    }
  }

  // ۸. خلاصه صفحه فعلی
  if (action === 'SUMMARIZE_PAGE') {
    if (!pageContext?.content || pageContext.content.trim().length < 20) {
      return 'صفحه جاری متنی برای خلاصه‌سازی ندارد (یا هنوز سایتی باز نشده است). لطفاً وارد یک مقاله شوید.';
    }
    sender.send('ai-status', 'در حال خلاصه‌سازی متن صفحه جاری...');
    const pagePrompt = [
      { role: 'system', content: 'متن این صفحه وب را به زبان فارسی خلاصه، تمیز و نکات مهم آن را ذکر کن:' },
      { role: 'user', content: pageContext.content.slice(0, 3000) }
    ];
    return await callOllamaChat(DEFAULT_TEXT_MODEL, pagePrompt, null, 0.2);
  }

  // ۹. ترجمه صفحه
  if (action === 'TRANSLATE_PAGE') {
    if (pageContext?.url && !pageContext.url.includes('translate.google.com')) {
      const transUrl = `https://translate.google.com/translate?sl=auto&tl=fa&u=${encodeURIComponent(pageContext.url)}`;
      return `ACTION: OPEN ${transUrl}\nدر حال ترجمه مستقیم کل صفحه به زبان فارسی...`;
    }
    return 'صفحه‌ای برای ترجمه باز نیست.';
  }

  // ۱۰. چت و مکالمه عادی
  if (decision.message && decision.message.trim().length > 3) {
    return decision.message;
  }

  const chatPrompt = [
    { role: 'system', content: 'تو دستیار هوشمند و متصل به اینترنت در مرورگر اینترنتی VOID هستی. به فارسی روان و صمیمی پاسخ بده:' },
    { role: 'user', content: rawMsg }
  ];
  return await callOllamaChat(DEFAULT_TEXT_MODEL, chatPrompt, null, 0.4);
});

// =====================================================================
// 🎬 دانلود کیفیت‌ها و دوبله صوتی
// =====================================================================
ipcMain.handle('get-video-formats', async (_event, url) => {
  await waitForTools(null);
  const { ytdlp } = getToolPaths();
  if (!fs.existsSync(ytdlp)) return { success: false, message: 'ابزارها هنوز آماده نشده‌اند — چند لحظه بعد دوباره امتحان کنید (دانلود خودکار در جریان است).' };
  return new Promise((resolve) => {
    exec(`"${ytdlp}" --no-playlist -F "${url}"`, { timeout: 60000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errLine = String(stderr || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('ERROR')).pop() || error.message;
        return resolve({ success: false, message: `استخراج فرمت‌ها ناموفق بود — ${errLine}` });
      }
      resolve({ success: true, raw: stdout });
    });
  });
});

ipcMain.on('start-custom-download', async (event, { id, url, formatId }) => {
  await waitForTools(event.sender);
  const { ytdlp, ffmpegDir } = getToolPaths();
  const downloadsPath = app.getPath('downloads');
  const send = (channel, payload) => { try { event.sender.send(channel, payload); } catch {} };
  if (!fs.existsSync(ytdlp)) return send('download-status', { id, status: 'error', message: 'ابزارها آماده نیستند — اینترنت را بررسی و چند لحظه بعد دوباره امتحان کنید' });
  // «بهترین (خودکار)»: ترکیب بهترین ویدیو + بهترین صدا (در یوتیوب best تنها معمولاً فقط 360p است)
  const formatSelector = formatId === 'best'
    ? 'bestvideo*+bestaudio/best'
    : `${formatId}+bestaudio/${formatId}/best`;
  const args = [
    url, '--no-playlist', '--newline', '--no-part', '--progress',
    '--ffmpeg-location', ffmpegDir,
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '-o', path.join(downloadsPath, '%(title)s-%(resolution)s.%(ext)s')
  ];
  const child = spawn(ytdlp, args, { windowsHide: true });
  let buffer = '';
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('[download]')) {
        // فاز پس از دانلود: ترکیب ویدیو و صدا با ffmpeg
        if (line.startsWith('[Merger]') || line.startsWith('[FixingM')) {
          send('download-progress', { id, percent: 100, message: 'در حال ترکیب ویدیو و صدا...' });
        }
        continue;
      }
      const percentMatch = line.match(/([\d.]+)\s*%/);
      if (!percentMatch) continue;
      const speedMatch = line.match(/at\s+([\d.]+\S*\/s)/);
      const etaMatch = line.match(/ETA\s+(\S+)/);
      const totalMatch = line.match(/of\s+~?\s*([\d.]+\w?i?B)/);
      send('download-progress', {
        id,
        percent: parseFloat(percentMatch[1]),
        totalSize: totalMatch ? totalMatch[1] : '',
        speed: speedMatch ? speedMatch[1] : '',
        eta: etaMatch ? etaMatch[1] : ''
      });
    }
  });
  let errTail = '';
  child.stderr.on('data', (data) => { errTail = (errTail + data.toString()).slice(-800); });
  child.on('error', (err) => send('download-status', { id, status: 'error', message: `خطا در اجرای yt-dlp: ${err.message}` }));
  child.on('close', (code) => {
    if (code === 0) return send('download-status', { id, status: 'completed', message: 'دانلود کامل شد — پوشه Downloads' });
    const errLines = errTail.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('ERROR'));
    const reason = errLines.length ? errLines[errLines.length - 1] : (errTail.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() || `کد خروج ${code}`);
    send('download-status', { id, status: 'error', message: `خطا در دانلود — ${reason}` });
  });
});

ipcMain.on('start-dub-download', async (event, { id, url, voice, quality }) => {
  await waitForTools(event.sender);
  const paths = getDubPaths();
  const missing = [];
  if (!fs.existsSync(paths.ytdlp)) missing.push('yt-dlp.exe');
  if (!fs.existsSync(paths.ffmpeg)) missing.push('ffmpeg.exe');
  if (!fs.existsSync(paths.whisperCli)) missing.push('whisper-cli.exe');
  if (!fs.existsSync(paths.whisperModelPath)) missing.push('whisper model');
  if (missing.length) return event.sender.send('dub-status', { id, status: 'error', message: `فایل نیست: ${missing.join(', ')}` });
  
  try {
    await ensureLocalAiServer(event.sender);
    await runDubPipeline(event, id, { 
      url, 
      voice: voice || 'fa-IR-DilaraNeural', 
      model: DEFAULT_TEXT_MODEL,
      targetQuality: quality || '720', 
      paths 
    });
  } catch (err) {
    event.sender.send('dub-status', { id, status: 'error', message: err.message });
  }
});

ipcMain.on('cancel-dub-download', (_event, { id }) => {
  const job = activeJobs.get(id);
  if (job) job.cancelled = true;
});

app.whenReady().then(() => {
  createWindow();
  // 📦 دانلود خودکار ابزارها در اولین اجرا (پس از باز شدن پنجره)
  startToolsSetup();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });