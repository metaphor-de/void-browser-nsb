process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const activeJobs = new Map();
const OLLAMA_HOST = 'http://127.0.0.1:11434';

function log(...args) { console.log('[dub-pipeline]', ...args); }

function emitProgress(event, jobId, stage, percent, message) {
  try { event.sender.send('dub-progress', { id: jobId, stage, percent, message }); } catch {}
}

function emitStatus(event, jobId, status, message = '', outputPath = null) {
  try { event.sender.send('dub-status', { id: jobId, status, message, outputPath }); } catch {}
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function timeToSeconds(str) {
  const m = str.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function parseSRT(content) {
  const segs = [];
  const blocks = content.replace(/\r/g, '').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const [s, e] = timeLine.split('-->').map(t => t.trim());
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    segs.push({ start: timeToSeconds(s), end: timeToSeconds(e), text });
  }
  return segs;
}

function mergeBrokenSegments(rawSegments) {
  if (!rawSegments || rawSegments.length === 0) return [];
  const merged = [];
  let current = { ...rawSegments[0] };

  for (let i = 1; i < rawSegments.length; i++) {
    const next = rawSegments[i];
    const endsWithPunctuation = /[.?!]$/.test(current.text.trim());
    const timeGap = next.start - current.end;

    if (!endsWithPunctuation && timeGap < 0.8 && (current.text.length + next.text.length < 180)) {
      current.text += ' ' + next.text;
      current.end = next.end;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

async function getAudioDuration(filePath, ffprobe) {
  try {
    const { stdout } = await runCommand(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch (e) {
    return 0;
  }
}

// 🟢 ترجمه پرسرعت دوبلاژ با مدل qwen2.5:3b در Ollama
async function translateWithOllama(text, previousContext, model = 'qwen2.5:3b') {
  try {
    const prompt = `شما مدیر دوبلاژ و مترجم بسیار باتجربه فیلم هستید. جمله انگلیسی زیر را برای دوبله فارسی عامیانه، طبیعی و روان ترجمه کن.
جمله قبلی: "${previousContext || 'شروع'}"
جمله‌ای که باید ترجمه شود: "${text}"

دستورات فوق‌العاده حیاتی:
۱. اصطلاحات و اسلنگ‌های انگلیسی را به هیچ عنوان لغوی ترجمه نکن؛ دقیقاً معادل گفتاری و روزمره‌ای که در دوبله فارسی به کار می‌رود جایگزین کن.
۲. تعداد کلمات کوتاه و هماهنگ با زمان صحبت باشد.
فقط و فقط متن ترجمه فارسی را بنویس بدون هیچ گیومه، پرانتز یا کلمه انگلیسی اضافی:`;

    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
          temperature: 0.25,
          num_predict: 120
        }
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let result = (data?.message?.content || '').trim();
    return result.replace(/^["'«\s]+|["'»\s]+$/g, '').trim() || text;
  } catch (e) {
    log('Ollama translate error:', e.message);
    return text;
  }
}

async function getMicrosoftTTS(text, outputPath) {
  try {
    const tts = new MsEdgeTTS();
    const fmt = OUTPUT_FORMAT?.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || 'audio-24khz-48kbitrate-mono-mp3';
    await tts.setMetadata('fa-IR-DilaraNeural', fmt);
    const result = tts.toStream(text);
    const stream = result?.audioStream || result;
    
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);
      stream.pipe(writer);
      stream.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
    });
  } catch (e) {
    throw new Error(`TTS Error: ${e.message}`);
  }
}

async function runDubPipeline(event, jobId, options) {
  const {
    url, 
    model = 'qwen2.5:3b',
    targetQuality = '720', 
    paths,
  } = options;

  const { ytdlp, ffmpeg, ffprobe, whisperCli, whisperModelPath, downloadsDir } = paths;
  const jobDir = path.join(os.tmpdir(), `void-dub-${jobId}-${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  activeJobs.set(jobId, { dir: jobDir, cancelled: false });

  const cancelCheck = () => { if (activeJobs.get(jobId)?.cancelled) throw new Error('CANCELLED'); };

  try {
    emitProgress(event, jobId, 'download', 0, 'در حال دانلود ویدیو...');
    const videoPath = path.join(jobDir, 'video.mp4');
    const fmtSel = targetQuality === 'best'
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : `bestvideo[height<=${targetQuality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${targetQuality}][ext=mp4]/best`;

    await new Promise((resolve, reject) => {
      const child = spawn(ytdlp, [
        url, '--no-playlist', '--newline', '--ffmpeg-location', path.dirname(ffmpeg),
        '-f', fmtSel, '--merge-output-format', 'mp4', '-o', videoPath,
      ], { windowsHide: true });
      let buf = '';
      child.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/); buf = lines.pop() || '';
        for (const line of lines) {
          const pm = line.match(/([\d.]+)\s*%/);
          if (pm) emitProgress(event, jobId, 'download', parseFloat(pm[1]) * 0.15, `دانلود: ${pm[1]}%`);
        }
      });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)));
    });
    cancelCheck();

    emitProgress(event, jobId, 'extract', 15, 'استخراج صدای ویدیو...');
    const audioWav = path.join(jobDir, 'audio.wav');
    await runCommand(ffmpeg, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioWav]);
    cancelCheck();

    emitProgress(event, jobId, 'transcribe', 20, 'تشخیص هوشمند گفتار...');
    const srtBase = path.join(jobDir, 'subs');
    await runCommand(whisperCli, ['-m', whisperModelPath, '-f', audioWav, '-l', 'en', '-osrt', '-of', srtBase, '-t', '8', '--print-progress']);
    cancelCheck();

    const srtPath = srtBase + '.srt';
    if (!fs.existsSync(srtPath)) throw new Error('فایل زیرنویس ایجاد نشد');
    const rawSegments = parseSRT(fs.readFileSync(srtPath, 'utf8'));
    if (rawSegments.length === 0) throw new Error('هیچ گفتاری در ویدیو تشخیص داده نشد');

    const segments = mergeBrokenSegments(rawSegments);
    emitProgress(event, jobId, 'translate', 40, `ترجمه اصطلاحات در قالب ${segments.length} جمله با qwen2.5:3b...`);

    let prevContext = '';
    for (let i = 0; i < segments.length; i++) {
      cancelCheck();
      segments[i].persian = await translateWithOllama(segments[i].text, prevContext, model);
      prevContext = segments[i].text;
      emitProgress(event, jobId, 'translate', 40 + ((i + 1) / segments.length) * 20, `دوبله جمله ${i + 1} از ${segments.length}`);
    }
    cancelCheck();

    emitProgress(event, jobId, 'tts', 60, 'تولید صدای گوینده و تنظیم ریتم...');
    const concatLines = [];
    let cursor = 0;

    for (let i = 0; i < segments.length; i++) {
      cancelCheck();
      const seg = segments[i];
      if (!seg.persian || seg.persian === 'ترجمه نشد') continue;

      const target = Math.max(0.1, seg.end - seg.start);

      if (seg.start > cursor + 0.05) {
        const gapFile = path.join(jobDir, `gap_${i}.mp3`);
        await runCommand(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', (seg.start - cursor).toFixed(3), '-acodec', 'libmp3lame', '-q:a', '5', gapFile]);
        concatLines.push(`file '${gapFile.replace(/\\/g, '/')}'`);
      }

      const rawTts = path.join(jobDir, `tts_raw_${i}.mp3`);
      try {
        await getMicrosoftTTS(seg.persian, rawTts);
      } catch (e) {
        continue;
      }

      const ttsDur = await getAudioDuration(rawTts, ffprobe);
      if (!ttsDur || ttsDur < 0.05) continue;

      const filters = [];
      if (ttsDur > target) {
        const safeRate = Math.min(ttsDur / target, 1.25);
        filters.push(`atempo=${safeRate.toFixed(3)}`);
      }
      filters.push(`apad=whole_dur=${target.toFixed(3)}`);
      filters.push(`atrim=0:${target.toFixed(3)}`);

      const finalTts = path.join(jobDir, `tts_final_${i}.mp3`);
      await runCommand(ffmpeg, ['-y', '-i', rawTts, '-af', filters.join(','), '-ar', '24000', '-ac', '1', '-acodec', 'libmp3lame', '-q:a', '5', finalTts]);
      concatLines.push(`file '${finalTts.replace(/\\/g, '/')}'`);
      cursor = seg.start + target;
      
      emitProgress(event, jobId, 'tts', 60 + ((i + 1) / segments.length) * 20, `صداگذاری ${i + 1}/${segments.length}`);
    }
    cancelCheck();

    emitProgress(event, jobId, 'merge', 80, 'میکس استودیویی صدا و ویدیو...');
    const concatPath = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatPath, concatLines.join('\n'), 'utf8');
    const persianTrack = path.join(jobDir, 'persian.mp3');
    await runCommand(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c:a', 'libmp3lame', '-q:a', '4', persianTrack]);

    const outName = `VOID_Dubbed_${Date.now()}.mp4`;
    const outputPath = path.join(downloadsDir, outName);
    
    await runCommand(ffmpeg, [
      '-y', '-i', videoPath, '-i', persianTrack,
      '-filter_complex', '[0:a]volume=0.10[orig];[orig][1:a]amix=inputs=2:duration=first[aout]',
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outputPath
    ]);

    emitProgress(event, jobId, 'merge', 100, 'دوبله کامل شد');
    emitStatus(event, jobId, 'completed', 'دوبله با موفقیت ساخته شد!', outputPath);

  } catch (err) {
    emitStatus(event, jobId, err.message === 'CANCELLED' ? 'cancelled' : 'error', err.message);
  } finally {
    activeJobs.delete(jobId);
  }
}

module.exports = { runDubPipeline, activeJobs };