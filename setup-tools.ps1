# ============================================================
#  VOID Browser — دانلود خودکار ابزارهای مورد نیاز
#  این اسکریپت را کنار فایل‌های پروژه اجرا کنید:
#   powershell -ExecutionPolicy Bypass -File setup-tools.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$whisperDir = Join-Path $root 'whisper_resources'

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "   !! $msg" -ForegroundColor Yellow }

function Download($url, $dest) {
    $name = Split-Path $dest -Leaf
    Write-Host "   دانلود: $name ..." -NoNewline
    try {
        #UseBasicParsing + retry
        for ($i = 1; $i -le 3; $i++) {
            try {
                Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
                break
            } catch {
                if ($i -eq 3) { throw }
                Start-Sleep -Seconds 3
            }
        }
        Write-Host " تمام شد" -ForegroundColor Green
        return $true
    } catch {
        Write-Host " ناموفق!" -ForegroundColor Red
        Write-Warn2 "خطا در دانلود از: $url"
        return $false
    }
}

# ------------------------------------------------------------
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " راه‌اندازی ابزارهای VOID Browser" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

# --- 0) Node.js و وابستگی‌ها ---
Write-Step "بررسی Node.js و نصب وابستگی‌ها (node_modules)"
try {
    $nodeVer = node --version 2>$null
    if ($nodeVer) {
        Write-Ok "Node $nodeVer"
        Push-Location $root
        npm install --no-audit --no-fund 2>&1 | Out-Null
        Pop-Location
        if (Test-Path (Join-Path $root 'node_modules')) { Write-Ok "node_modules نصب شد" }
        else { Write-Warn2 "npm install ناموفق بود — دستی اجرا کنید: npm install" }
    } else {
        Write-Warn2 "Node.js نصب نیست! از nodejs.org نصب کنید، بعد دوباره این اسکریپت را اجرا کنید."
    }
} catch { Write-Warn2 "npm install با خطا مواجه شد: $($_.Exception.Message)" }

# --- 1) ffmpeg + ffprobe ---
Write-Step "ffmpeg و ffprobe (حدود 110 مگابایت)"
$needFfmpeg = -not ((Test-Path (Join-Path $root 'ffmpeg.exe')) -and (Test-Path (Join-Path $root 'ffprobe.exe')))
if (-not $needFfmpeg) { Write-Ok "از قبل موجود است" }
else {
    $tmp = Join-Path $env:TEMP "void-setup-ffmpeg"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'ffmpeg.zip'
    $ok = Download 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
    if (-not $ok) {
        Write-Warn2 "تلاش با سرور جایگزین (BtbN / GitHub)..."
        $ok = Download 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $zip
    }
    if ($ok) {
        try {
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            $binDir = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($binDir) {
                $src = $binDir.Directory.FullName
                Copy-Item (Join-Path $src 'ffmpeg.exe')  $root -Force
                Copy-Item (Join-Path $src 'ffprobe.exe') $root -Force
                Write-Ok "ffmpeg.exe و ffprobe.exe کپی شد"
            } else { Write-Warn2 "فایل‌های ffmpeg در زیپ پیدا نشد!" }
        } catch { Write-Warn2 "خطا در باز کردن زیپ ffmpeg: $($_.Exception.Message)" }
    }
}

# --- 2) yt-dlp ---
Write-Step "yt-dlp.exe (حدود 22 مگابایت)"
if (Test-Path (Join-Path $root 'yt-dlp.exe')) { Write-Ok "از قبل موجود است" }
else {
    $ok = Download 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $root 'yt-dlp.exe')
    if ($ok) { Write-Ok "yt-dlp.exe دانلود شد" }
}

# --- 3) whisper.cpp ---
Write-Step "whisper.cpp (حدود 9 مگابایت)"
if (Test-Path (Join-Path $whisperDir 'whisper-cli.exe')) { Write-Ok "از قبل موجود است" }
else {
    $tmp2 = Join-Path $env:TEMP "void-setup-whisper"
    New-Item -ItemType Directory -Force -Path $tmp2 | Out-Null
    $zip2 = Join-Path $tmp2 'whisper.zip'
    $ok = Download 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' $zip2
    if ($ok) {
        try {
            $ex = Join-Path $tmp2 'ex'
            Expand-Archive -Path $zip2 -DestinationPath $ex -Force
            $rel = Get-ChildItem -Path $ex -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
            if ($rel) {
                New-Item -ItemType Directory -Force -Path $whisperDir | Out-Null
                #فایل‌های لازم را کپی می‌کنیم (exe های تست و ابزارهای اضافه لازم نیستند)
                Copy-Item -Path (Join-Path $rel.Directory.FullName '*') -Destination $whisperDir -Force -Exclude @('test-*.exe','bench.exe','command.exe','main.exe','stream.exe','parakeet*','wchess.exe','whisper-bench.exe','whisper-command.exe','whisper-lsp.exe','whisper-quantize.exe','whisper-stream.exe','whisper-talk-llama.exe','whisper-vad-speech-segments.exe')
                Write-Ok "whisper_resources آماده شد"
            }
        } catch { Write-Warn2 "خطا در باز کردن زیپ whisper: $($_.Exception.Message)" }
    }
}

# --- 4) مدل whisper ---
Write-Step "انتخاب مدل تشخیص گفتار (whisper)"
$existing = Get-ChildItem -Path $whisperDir -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) { Write-Ok "مدل موجود: $($existing.Name)" }
else {
    Write-Host ""
    Write-Host "   کدام مدل دانلود شود؟ (برای دوبله ویدیو، گزینه 2 پیشنهاد می‌شود)" -ForegroundColor White
    Write-Host "   1) ggml-small.bin        (465 MB — دقیق‌ترین، تشخیص عالی)" 
    Write-Host "   2) ggml-small-q5_1.bin   (181 MB — کیفیت نزدیک به گزینه 1، حجم کمتر) [پیشنهادی]"
    Write-Host "   3) ggml-base.bin          (141 MB — سریع‌تر، دقت کمتر)"
    Write-Host "   4) ggml-base-q5_1.bin     ( 57 MB — کم‌حجم‌ترین، دقت پایین‌تر)"
    Write-Host "   5) فعلاً رد کن"
    Write-Host ""
    $choice = Read-Host "   انتخاب شما (1-5)"
    $models = @{
        '1' = @{ f = 'ggml-small.bin';      s = '465 MB' }
        '2' = @{ f = 'ggml-small-q5_1.bin'; s = '181 MB' }
        '3' = @{ f = 'ggml-base.bin';       s = '141 MB' }
        '4' = @{ f = 'ggml-base-q5_1.bin';  s = ' 57 MB' }
    }
    if ($models.ContainsKey($choice)) {
        $m = $models[$choice]
        $ok = Download "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$($m.f)" (Join-Path $whisperDir $m.f)
        if ($ok) { Write-Ok "مدل $($m.f) ($($m.s)) دانلود شد" }
        else { Write-Warn2 "می‌توانید بعداً دستی از huggingface.co دانلود کنید و در پوشه whisper_resources بگذارید" }
    } else { Write-Warn2 "مدل رد شد — دوبله تا بعد از دانلود مدل کار نخواهد کرد" }
}

# ------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " تمام شد!" -ForegroundColor Green
Write-Host " برای اجرای برنامه:" -ForegroundColor White
Write-Host "    npm start" -ForegroundColor Yellow
Write-Host ""
Write-Host " نکته: برای دوبله ویدیو، سرور Ollama هم لازم است." -ForegroundColor White
Write-Host " از ollama.com نصب کنید و بعد در CMD این دستور را بزنید:" -ForegroundColor White
Write-Host "    ollama pull qwen2.5:3b" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "اگر دانلودی ناموفق بود، احتمالاً به VPN نیاز دارید (GitHub/HuggingFace)" -ForegroundColor DarkGray
