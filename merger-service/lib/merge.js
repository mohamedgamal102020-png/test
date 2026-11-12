'use strict';
/**
 * lib/merge.js — محرك الدمج (الأهم):
 * ffprobe لكل مصدر ← توحيد الدقة/fps عبر filter_complex (scale+pad+fps+concat) ←
 * ترميز نهائي libx264 CRF18 + AAC 192k + faststart ← حفظ الناتج في Turso مع تقدم حقيقي.
 */
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const { limits } = require('./env');
const db = require('./db');
const storage = require('./storage');

const MAX_DIM = 1920;   // حد أقصى للعرض
const MAX_ROW = 1080;   // حد أقصى للارتفاع
const TARGET_FPS = 30;

/** خطأ أعمال مع كود HTTP ومناسب للصيغة {"error":"..."} */
function bizError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isBiz = true;
  return err;
}

/**
 * ثنائي ffmpeg قد يفقد صلاحية التنفيذ (خاصة على أنظمة ملفات تتجاهل وضع 755) —
 * ننسخه إلى /tmp بصلاحية 755 عند الحاجة. قرار مهم للنشر على بيئات مقيدة.
 */
function ensureExecutable(binPath, name) {
  if (!fs.existsSync(binPath)) {
    throw bizError(500, `ثنائي ${name} غير موجود على القرص`);
  }
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmpBin = path.join(os.tmpdir(), `merger-service-${name}`);
    fs.copyFileSync(binPath, tmpBin);
    fs.chmodSync(tmpBin, 0o755);
    return tmpBin;
  }
}

function getFfmpegPath() { return ensureExecutable(require('ffmpeg-static'), 'ffmpeg'); }
function getFfprobePath() {
  const mod = require('ffprobe-static');
  const p = mod && mod.path ? mod.path : mod;
  return ensureExecutable(p, 'ffprobe');
}

/** ffprobe لملف: الدقة، معدل الإطارات، المدة، وجود الصوت/الفيديو */
async function probeVideo(file) {
  const bin = getFfprobePath();
  let stdout;
  try {
    const res = await execFileAsync(bin, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], {
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (e) {
    throw bizError(400, `تعذر تحليل الملف "${path.basename(file)}" — قد لا يكون ملف فيديو صالحًا`);
  }
  let meta;
  try { meta = JSON.parse(stdout); } catch { throw bizError(400, 'تعذر قراءة بيانات الفيديو من ffprobe'); }

  const streams = meta.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw bizError(400, 'المصدر لا يحتوي على مسار فيديو صالح');

  // fps من avg_frame_rate بصيغة "num/den"
  let fps = null;
  const fr = String(video.avg_frame_rate || video.r_frame_rate || '');
  const fm = fr.match(/^(\d+)\/(\d+)$/);
  if (fm && Number(fm[2]) > 0) fps = Number(fm[1]) / Number(fm[2]);

  // المدة: من format ثم من أطول مسار كاحتياط
  let duration = Number(meta.format && meta.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = 0;
    for (const s of streams) {
      const d = Number(s.duration);
      if (Number.isFinite(d) && d > duration) duration = d;
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw bizError(400, 'تعذر تحديد مدة المصدر — ملف تالف أو غير مدعوم');
  }

  return {
    width: video.width,
    height: video.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    duration,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: true,
  };
}

/**
 * بناء filter_complex: توحيد كل المدخلات على أكبر دقة بينها (بحد 1920×1080 وأبعاد زوجية)،
 * fps=30، setsar=1، yuv420p، ومسار صوت لكل مقطع (صامت anullsrc لمن بلا صوت) ثم concat.
 */
function buildFilterGraph(probes, width, height) {
  const chains = [];
  const silentInputs = []; // مدخلات lavfi إضافية للمصادر الصامتة
  let silentCount = 0;
  probes.forEach((p, i) => {
    chains.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},setsar=1,format=yuv420p[v${i}]`
    );
    if (p.hasAudio) {
      // توحيد معدل العينة والصيغة والقنوات كي يقبلها فلتر concat دون أخطاء
      chains.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت؟ نضيف مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
      const silentIndex = probes.length + silentCount++;
      silentInputs.push({ duration: p.duration });
      chains.push(`[${silentIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    }
  });
  const concatIn = probes.map((_, i) => `[v${i}][a${i}]`).join('');
  chains.push(`${concatIn}concat=n=${probes.length}:v=1:a=1[vout][aout]`);
  return { filterComplex: chains.join(';'), silentInputs };
}

/** تشغيل ffmpeg مع قراءة التقدم من -progress pipe:1 (out_time_us) */
function runFfmpeg(args, { totalDuration, onProgress } = {}) {
  const bin = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', ...args]);
    let stderrTail = '';
    let stdoutBuf = '';

    child.stdout.on('data', (d) => {
      // ffmpeg يطبع أزواج key=value؛ نهتم بـ out_time_us لحساب النسبة
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && totalDuration > 0 && typeof onProgress === 'function') {
          const outSec = Number(m[1]) / 1e6;
          const frac = Math.max(0, Math.min(1, outSec / totalDuration));
          Promise.resolve(onProgress(frac)).catch(() => {});
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-8000); // نحتفظ بذيل الخطأ فقط
    });

    // مهلة قصوى سخية ضد التعليق (10 دقائق) — على Vercel تحسمها maxDuration أيضًا
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(bizError(500, 'تجاوز وقت الترميز الحد الأقصى المسموح'));
    }, 600000);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(bizError(500, `فشل تشغيل ffmpeg: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
      reject(bizError(500, `فشل ترميز الفيديو (رمز الخروج ${code}): ${tail || 'خطأ غير معروف'}`));
    });
  });
}

/**
 * دمج عدة ملفات فيديو محلية إلى ملف MP4 واحد عالي الجودة:
 * libx264 CRF 18 + AAC 192k/44100Hz + +faststart، والـ preset من FFMPEG_PRESET.
 */
async function mergeFiles({ inputs, probes, outPath, preset, width, height, onProgress } = {}) {
  if (!inputs || inputs.length < 2) throw bizError(400, 'يلزم مصدران على الأقل لدمج الفيديوهات');
  const { filterComplex, silentInputs } = buildFilterGraph(probes, width, height);

  const args = [];
  for (const input of inputs) args.push('-i', input);
  for (const s of silentInputs) {
    // مدخل صامت بنفس مدة المقطع المقابل (حد أدنى 0.1ث تجنبًا للقيم الصفرية)
    args.push('-f', 'lavfi', '-t', String(Math.max(0.1, s.duration)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  args.push(
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', preset || limits.ffmpegPreset,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath
  );

  const totalDuration = probes.reduce((a, p) => a + p.duration, 0);
  await runFfmpeg(args, { totalDuration, onProgress });
}

/** فرض حد حجم المصدر — يُستدعى أثناء التنزيل/التجميع بعدّ فوري للبايتات */
function enforceSourceSize(bytes, label) {
  if (bytes > limits.sourceMaxBytes) {
    throw bizError(413, `حجم ${label} يتجاوز الحد المسموح (${limits.sourceMaxMB}MB لكل مصدر)`);
  }
}

/** تنزيل مصدر من رابط مباشر إلى ملف مؤقت مع فرض حد الحجم لحظة بلحظة */
async function downloadUrlSource(url, destPath) {
  let resp;
  try {
    resp = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
      headers: { 'User-Agent': 'merger-service/1.0 (+video-merger)' },
    });
  } catch (e) {
    throw bizError(400, `تعذر الوصول إلى رابط المصدر — تأكد من صحته واتاحته للعموم (${e.name === 'TimeoutError' ? 'انتهت المهلة' : 'خطأ شبكة'})`);
  }
  if (!resp.ok) throw bizError(400, `تعذر تنزيل المصدر من الرابط (رمز الحالة ${resp.status})`);

  // إن أعلن الخادم الحجم مسبقًا نرفض فورًا قبل إهدار أي نقل
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > limits.sourceMaxBytes) {
    throw bizError(413, `حجم المصدر من الرابط يتجاوز الحد المسموح (${limits.sourceMaxMB}MB لكل مصدر)`);
  }
  if (!resp.body) throw bizError(400, 'المصدر من الرابط لا يوفر محتوى قابلاً للتنزيل');

  const out = fs.createWriteStream(destPath);
  let bytes = 0;
  try {
    const src = Readable.fromWeb(resp.body);
    for await (const chunk of src) {
      bytes += chunk.length;
      enforceSourceSize(bytes, 'المصدر من الرابط'); // فشل فوري عند أول تجاوز
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve) => out.end(resolve));
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch { /* لا شيء */ }
    if (e.isBiz) throw e;
    throw bizError(400, `فشل تنزيل المصدر من الرابط: ${e.message}`);
  } finally {
    out.destroy();
  }
  if (bytes === 0) throw bizError(400, 'الملف من الرابط فارغ');
  return bytes;
}

/**
 * تنفيذ المهمة كاملة: سحب المصادر (0–40) ← ترميز (40–90) ← حفظ الناتج (100).
 * يعيد نتيجة العملية أو يرمي خطأ أعمال برسالة عربية وكود HTTP صحيح.
 */
async function processJob(jobId, { onProgress } = {}) {
  const job = await db.getJob(jobId);
  if (!job) throw bizError(404, 'المهمة غير موجودة');
  const sources = await db.getSources(jobId);
  if (sources.length < 2) throw bizError(400, 'يلزم مصدران على الأقل لدمج الفيديوهات');
  if (sources.length > limits.maxSources) {
    throw bizError(400, `عدد المصادر (${sources.length}) يتجاوز الحد الأقصى (${limits.maxSources})`);
  }

  // تحقق من اكتمال الملفات المرفوعة قبل البدء (409 حالة غير مناسبة)
  for (const s of sources) {
    if (s.kind === 'file') {
      if (!s.size || (s.received || 0) !== s.size || !s.uploaded) {
        throw bizError(409, `لم يكتمل رفع الملف "${s.name || 'بدون اسم'}" — أعد رفع الأجزاء الناقصة أولًا`);
      }
    }
  }

  // مجلد عمل وحيد في /tmp يُنظَّف في finally — لا نعتمد على نظام ملفات دائم
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId.slice(0, 8)}-`));
  let lastWrite = 0;
  let lastVal = -1;
  const setProgress = async (p) => {
    const val = Math.max(0, Math.min(100, Math.round(p)));
    const now = Date.now();
    // تهدئة الكتابة للقاعدة (800ms) حتى لا نبني طلبات زائدة، مع ضمان قيمة نهائية صريحة
    if (val !== lastVal && now - lastWrite > 800) {
      lastWrite = now; lastVal = val;
      await db.updateJob(jobId, { progress: val });
    }
    if (typeof onProgress === 'function') Promise.resolve(onProgress(val)).catch(() => {});
  };

  try {
    // المرحلة 1: سحب المصادر (0–40)
    const paths = [];
    const probes = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src_${String(s.seq).padStart(3, '0')}`);
      if (s.kind === 'file') {
        await storage.assembleSourceToFile(jobId, s.seq, dest, limits.sourceMaxBytes);
        enforceSourceSize(s.size, `الملف "${s.name || ''}"`);
      } else {
        await downloadUrlSource(s.url, dest);
      }
      paths.push(dest);
      const meta = await probeVideo(dest);
      probes.push(meta);
      await setProgress(((i + 1) / sources.length) * 40);
    }

    // التحقق من الحد الإجمالي للمدة قبل أي ترميز
    const totalDuration = probes.reduce((a, p) => a + p.duration, 0);
    if (totalDuration > limits.maxTotalDurationSec) {
      throw bizError(400, `المدة الإجمالية للمصادر (${Math.round(totalDuration)} ثانية) تتجاوز الحد المسموح (${limits.maxTotalDurationSec} ثانية)`);
    }

    // أكبر دقة بين المدخلات بحد أقصى 1920×1080 وأبعاد زوجية
    let width = Math.max(...probes.map((p) => p.width || 0));
    let height = Math.max(...probes.map((p) => p.height || 0));
    width = Math.min(width, MAX_DIM); height = Math.min(height, MAX_ROW);
    width = Math.max(2, Math.floor(width / 2) * 2); height = Math.max(2, Math.floor(height / 2) * 2);

    // المرحلة 2: الترميز (40–90)
    const outPath = path.join(tmpDir, 'output.mp4');
    await mergeFiles({
      inputs: paths, probes, outPath,
      preset: limits.ffmpegPreset, width, height,
      onProgress: (frac) => setProgress(40 + frac * 50),
    });
    await setProgress(90);

    // التحقق من حجم الناتج قبل الحفظ
    const outSize = fs.statSync(outPath).size;
    if (outSize > limits.outputMaxBytes) {
      throw bizError(413, `حجم الفيديو الناتج (${(outSize / (1024 * 1024)).toFixed(1)}MB) يتجاوز الحد المسموح (${limits.outputMaxMB}MB)`);
    }

    // قراءة مواصفات الناتج الفعلي مع احتياط عند فشل التحليل
    let outMeta = null;
    try { outMeta = await probeVideo(outPath); } catch { outMeta = null; }
    const outDuration = outMeta ? outMeta.duration : totalDuration;
    const resolution = outMeta && outMeta.width ? `${outMeta.width}x${outMeta.height}` : `${width}x${height}`;

    // المرحلة 3: حفظ الناتج في Turso (90–100) وحذف أجزاء المصادر
    const buffer = fs.readFileSync(outPath);
    await storage.writeOutputBlob(jobId, buffer);
    await db.getDb().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
    const outputUrl = `/api/jobs/${jobId}/video`;
    await db.updateJob(jobId, {
      status: 'done',
      progress: 100,
      output_url: outputUrl,
      output_size: outSize,
      output_duration: outDuration,
      output_resolution: resolution,
      error: null,
    });
    await setProgress(100);

    return {
      jobId,
      size: outSize,
      duration: outDuration,
      resolution,
      expiresAt: job.expires_at,
    };
  } catch (e) {
    // أي فشل يعلن بوضوح في القاعدة برسالة عربية — لا انهيار صامت
    const message = e.isBiz ? e.message : `فشل غير متوقع أثناء المعالجة: ${e.message}`;
    try {
      await db.updateJob(jobId, { status: 'failed', error: message });
    } catch { /* لا شيء — نحافظ على الخطأ الأصلي */ }
    if (!e.isBiz) e.statusCode = e.statusCode || 500;
    throw e;
  } finally {
    // تنظيف مجلد العمل المؤقت دائمًا
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* لا شيء */ }
  }
}

module.exports = {
  bizError,
  ensureExecutable,
  getFfmpegPath,
  getFfprobePath,
  probeVideo,
  buildFilterGraph,
  runFfmpeg,
  mergeFiles,
  enforceSourceSize,
  downloadUrlSource,
  processJob,
  MAX_DIM,
  MAX_ROW,
  TARGET_FPS,
};
