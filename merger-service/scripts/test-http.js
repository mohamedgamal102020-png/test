'use strict';
/**
 * scripts/test-http.js — اختبارات HTTP حقيقية:
 * يشغّل scripts/dev-server.js على بورت 3001 وخادم ملفات محلي على بورت 3002، ثم يختبر:
 * إنشاء المهام (روابط + ملفات مرفوعة بأجزاء 4MB فعلية + مهمة مختلطة)، الدمج، بث Range،
 * رموز الأخطاء (400/404/405/409/413/416)، config، cron، CORS، والاستطلاع أثناء process.
 * في النهاية يُنظّف كل المهام الاختبارية من Turso عبر DELETE /api/jobs/{id}.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const merge = require('../lib/merge');
const { UPLOAD_CHUNK_BYTES } = require('../lib/env');

const BASE = 'http://localhost:3001';
const FILE_SERVER_PORT = 3002;

// ===== عدّاد النتائج =====
let pass = 0, fail = 0;
const failures = [];
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
async function test(name, fn) {
  try { await fn(); report(name, true); } catch (e) { report(name, false, e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ===== أدوات HTTP =====
async function req(method, urlPath, { body, headers, raw } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const r = await fetch(BASE + urlPath, { method, body, headers, signal: controller.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
    return { status: r.status, headers: r.headers, buf, json };
  } finally {
    clearTimeout(timer);
  }
}

const FFMPEG = merge.getFfmpegPath();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merger-http-'));
const createdJobs = []; // كل مهمة اختبارية تُحذف في النهاية إلزاميًا
let devServer = null;
let fileServer = null;

function generateVideo(dest, opts) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (opts.audio) {
    args.push('-f', 'lavfi', '-i', `testsrc=duration=${opts.duration}:size=${opts.size}:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${opts.duration}`);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest');
  } else {
    args.push('-f', 'lavfi', '-i', `testsrc2=duration=${opts.duration}:size=${opts.size}:rate=30`);
    if (opts.noise) args.push('-vf', `noise=alls=${opts.noise}:allf=t`); // ضوضاء تمنع الانضغاط لضمان حجم كبير ثابت
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(opts.crf || 24), '-preset', 'ultrafast');
  }
  args.push(dest);
  execFileSync(FFMPEG, args, { stdio: 'pipe' });
  return fs.statSync(dest).size;
}

/** رفع ملف كامل بأجزاء 4MB مع إعادة محاولة ×3 لكل جزء — نفس منطق الواجهة */
async function uploadFile(uploadUrl, filePath) {
  const data = fs.readFileSync(filePath);
  const total = Math.ceil(data.length / UPLOAD_CHUNK_BYTES);
  for (let k = 0; k < total; k++) {
    const chunk = data.subarray(k * UPLOAD_CHUNK_BYTES, (k + 1) * UPLOAD_CHUNK_BYTES);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await req('POST', `/api/upload` + new URL(uploadUrl).search + `&chunk=${k}`, { body: chunk });
      if (r.status === 200 && r.json && r.json.ok) { lastErr = null; break; }
      lastErr = `رمز ${r.status}: ${r.json && r.json.error}`;
      await new Promise((res) => setTimeout(res, 500 * attempt));
    }
    if (lastErr) throw new Error(`فشل رفع الجزء ${k} من ${path.basename(filePath)} — ${lastErr}`);
  }
  return total;
}

(async () => {
  console.log('=== اختبارات HTTP (test-http.js) ===\n');

  // 1) تشغيل dev-server على 3001
  devServer = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
    env: { ...process.env, PORT: '3001' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devServer.stderr.on('data', (d) => process.stderr.write('[dev-server] ' + d));

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { const r = await req('GET', '/api/config'); ready = r.status === 200; }
    catch { await new Promise((res) => setTimeout(res, 250)); }
  }
  if (!ready) throw new Error('dev-server لم يستعد على 3001');
  console.log('dev-server جاهز على 3001\n');

  // 2) خادم ملفات محلي على 3002 لخدمة روابط الفيديو الاختبارية
  const fileMap = {};
  fileServer = http.createServer((rq, rs) => {
    const name = decodeURIComponent(rq.url.slice(1));
    const file = fileMap[name];
    if (!file || !fs.existsSync(file)) { rs.writeHead(404); rs.end('not found'); return; }
    const stat = fs.statSync(file);
    rs.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) });
    fs.createReadStream(file).pipe(rs);
  });
  await new Promise((resolve) => fileServer.listen(FILE_SERVER_PORT, resolve));

  // توليد الملفات الاختبارية
  const fileA = path.join(tmpDir, 'a_320x240_2s.mp4');   // صغير مع صوت sine
  const fileB = path.join(tmpDir, 'b_640x360_4s.mp4');   // ~8MB بلا صوت (ضوضاء) لأجزاء رفع متعددة
  const fileC = path.join(tmpDir, 'c_320x240_1.5s.mp4'); // صغير بلا صوت (مهمة مختلطة)
  generateVideo(fileA, { duration: 2, size: '320x240', audio: true });
  const sizeB = generateVideo(fileB, { duration: 4, size: '640x360', audio: false, noise: 20, crf: 24 });
  generateVideo(fileC, { duration: 1.5, size: '320x240', audio: false });
  fileMap['a.mp4'] = fileA;
  fileMap['b.mp4'] = fileB;
  // ===== اختبارات أساسية =====
  await test('GET /api/config يعيد الحدود وversion', async () => {
    const r = await req('GET', '/api/config');
    assert(r.status === 200, `رمز ${r.status}`);
    assert(r.json && r.json.maxSources === 10 && r.json.sourceMaxMB === 200 && r.json.uploadChunkBytes === 4194304 && r.json.version, 'حقول الحدود ناقصة');
    assert(r.headers.get('access-control-allow-origin') === '*', 'CORS مفقود');
  });

  await test('OPTIONS /api/jobs → 204 مع CORS مفتوح', async () => {
    const r = await req('OPTIONS', '/api/jobs');
    assert(r.status === 204, `رمز ${r.status}`);
    assert(r.headers.get('access-control-allow-origin') === '*', 'CORS مفقود');
  });

  await test('GET / يخدم واجهة عربية كاملة', async () => {
    const r = await req('GET', '/');
    assert(r.status === 200, `رمز ${r.status}`);
    assert(r.buf.toString('utf8').includes('دمج الفيديوهات'), 'محتوى الواجهة مفقود');
  });

  await test('POST /api/jobs بجسم JSON تالف → 400 برسالة عربية', async () => {
    const r = await req('POST', '/api/jobs', { body: Buffer.from('{invalid json'), headers: { 'Content-Type': 'application/json' } });
    assert(r.status === 400, `رمز ${r.status}`);
    assert(r.json && /JSON/.test(r.json.error), 'رسالة خطأ غير مناسبة');
  });

  await test('POST /api/jobs بمصفوفة فارغة → 400', async () => {
    const r = await req('POST', '/api/jobs', { body: JSON.stringify({ videos: [] }), headers: { 'Content-Type': 'application/json' } });
    assert(r.status === 400, `رمز ${r.status}`);
  });

  await test('رابط غير صالح → 400', async () => {
    const r = await req('POST', '/api/jobs', { body: JSON.stringify({ videos: ['ftp://x.mp4'] }), headers: { 'Content-Type': 'application/json' } });
    assert(r.status === 400, `رمز ${r.status}`);
  });

  await test('PUT على /api/jobs → 405', async () => {
    const r = await req('PUT', '/api/jobs', { body: '{}' });
    assert(r.status === 405, `رمز ${r.status}`);
  });

  // ===== مهمة من مصدر واحد → 400 عربي عند process =====
  let singleJobId = null;
  await test('مهمة بمصدر واحد تُنشأ 201 ثم process → 400 برسالة عربية', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ videos: ['http://localhost:3002/a.mp4'] }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert(c.status === 201, `رمز الإنشاء ${c.status}`);
    assert(c.json.statusUrl && c.json.processUrl && c.json.expiresAt, 'حقول الاستجابة ناقصة');
    singleJobId = c.json.jobId;
    createdJobs.push(singleJobId);
    const p = await req('POST', `/api/jobs/${singleJobId}/process`);
    assert(p.status === 400, `رمز process ${p.status}`);
    assert(p.json && /مصدر/.test(p.json.error), `الرسالة ليست عربية متوقعة: ${p.json && p.json.error}`);
  });

  // ===== مهمة من روابط مباشرة (خادم 3002) + استطلاع التقدم أثناء process =====
  let urlJobId = null;
  await test('مهمة من روابط: إنشاء 201 ← process ← done مع استطلاع تقدم حقيقي', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ videos: ['http://localhost:3002/a.mp4', 'http://localhost:3002/b.mp4'] }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert(c.status === 201, `رمز ${c.status}`);
    urlJobId = c.json.jobId;
    createdJobs.push(urlJobId);

    // نطلق process دون انتظار ونستطلع GET كل 300ms للتأكد من تحديث التقدم من الخادم
    const processPromise = req('POST', `/api/jobs/${urlJobId}/process`);
    const seen = new Set();
    let doneStatus = null;
    for (let i = 0; i < 600; i++) {
      await new Promise((res) => setTimeout(res, 300));
      const s = await req('GET', `/api/jobs/${urlJobId}`);
      if (s.status === 200 && s.json) {
        seen.add(s.json.status);
        if (s.json.status === 'processing') seen.add('progress-' + Math.floor((s.json.progress || 0) / 10) * 10);
        if (s.json.status === 'done' || s.json.status === 'failed') { doneStatus = s.json.status; break; }
      }
    }
    const p = await processPromise;
    assert(p.status === 200 && p.json && p.json.status === 'done', `process: ${p.status} ${JSON.stringify(p.json)}`);
    assert(doneStatus === 'done', `حالة الاستطلاع النهائية: ${doneStatus}`);
    const sawEncoding = [...seen].some((v) => {
      const m = /^progress-(\d+)$/.exec(v);
      return m && Number(m[1]) >= 10; // أي دلو تقدم غير الصفر يثبت التحديث من الخادم (سحب 0-40، ترميز 40-90)
    });
    assert(sawEncoding, `لم يُلاحظ تقدم من الخادم (الملاحظات: ${[...seen].join(',')})`);
    assert(p.json.videoUrl.includes('/api/jobs/') && p.json.downloadUrl.includes('download=1'), 'روابط النتيجة ناقصة');
    assert(p.json.resolution === '640x360', `الدقة ${p.json.resolution}`);
    const dur = p.json.duration;
    assert(Math.abs(dur - 6) <= 1, `المدة ${dur}`);
    assert(p.json.size > 0 && p.json.expiresAt, 'حجم/صلاحية ناقصة');
  });

  await test('POST process على مهمة منتهية يعيد النتيجة دون إعادة ترميز', async () => {
    const p = await req('POST', `/api/jobs/${urlJobId}/process`);
    assert(p.status === 200 && p.json.status === 'done' && p.json.size > 0, `رمز ${p.status}`);
  });

  // ===== مهمة من ملفات مرفوعة بأجزاء 4MB فعلية =====
  let upJobId = null;
  await test('مهمة مرفوعة: أجزاء 4MB فعلية (6MB → جزءان) ← process ← done', async () => {
    assert(sizeB > UPLOAD_CHUNK_BYTES, `حجم الملف B (${sizeB}) لا يكفي لاختبار أجزاء متعددة`);
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ sources: [
        { kind: 'file', name: 'a.mp4', size: fs.statSync(fileA).size, mime: 'video/mp4' },
        { kind: 'file', name: 'b.mp4', size: sizeB, mime: 'video/mp4' },
      ] }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert(c.status === 201, `رمز ${c.status}`);
    assert(c.json.status === 'uploading' && Array.isArray(c.json.uploads) && c.json.uploads.length === 2 && c.json.uploadChunkBytes === 4194304, 'بيانات الرفع ناقصة');
    upJobId = c.json.jobId;
    createdJobs.push(upJobId);

    const chunksA = await uploadFile(c.json.uploads[0].uploadUrl, fileA);
    const chunksB = await uploadFile(c.json.uploads[1].uploadUrl, fileB);
    assert(chunksA === 1 && chunksB >= 2, `عدد الأجزاء A=${chunksA} B=${chunksB}`);

    // التحقق من الحالة بعد الرفع الكامل
    const st = await req('GET', `/api/jobs/${upJobId}`);
    assert(st.json.sources.every((s) => s.uploaded === true), 'المصادر لم تُعلَّم مكتملة');

    const p = await req('POST', `/api/jobs/${upJobId}/process`);
    assert(p.status === 200 && p.json.status === 'done', `process: ${p.status} ${JSON.stringify(p.json)}`);
    assert(p.json.resolution === '640x360', `الدقة ${p.json.resolution}`);
    assert(Math.abs(p.json.duration - 6) <= 1, `المدة ${p.json.duration}`);
  });

  // ===== مهمة مختلطة: رابط + ملف مرفوع =====
  let mixJobId = null;
  await test('مهمة مختلطة (رابط 3002 + ملف مرفوع) ← done', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ sources: [
        { kind: 'url', url: 'http://localhost:3002/a.mp4' },
        { kind: 'file', name: 'c.mp4', size: fs.statSync(fileC).size, mime: 'video/mp4' },
      ] }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert(c.status === 201 && c.json.uploads.length === 1, `رمز ${c.status}`);
    mixJobId = c.json.jobId;
    createdJobs.push(mixJobId);
    await uploadFile(c.json.uploads[0].uploadUrl, fileC);
    const p = await req('POST', `/api/jobs/${mixJobId}/process`);
    assert(p.status === 200 && p.json.status === 'done', `process: ${p.status} ${JSON.stringify(p.json)}`);
    assert(p.json.resolution === '640x360' || p.json.resolution === '320x240', `الدقة ${p.json.resolution}`);
  });

  // ===== بث الفيديو وRange =====
  await test('GET video يدعم Range: bytes=0-999 → 206 + Content-Range صحيح + 1000 بايت', async () => {
    const r = await fetch(`${BASE}/api/jobs/${upJobId}/video`, { headers: { Range: 'bytes=0-999' } });
    assert(r.status === 206, `رمز ${r.status}`);
    const size = Number(r.headers.get('content-range').split('/')[1]);
    assert(r.headers.get('content-range') === `bytes 0-999/${size}`, `Content-Range: ${r.headers.get('content-range')}`);
    assert(r.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges مفقود');
    assert(r.headers.get('content-type') === 'video/mp4', 'Content-Type غير صحيح');
    const buf = Buffer.from(await r.arrayBuffer());
    assert(buf.length === 1000, `الطول ${buf.length}`);
    assert(Number(r.headers.get('content-length')) === 1000, 'Content-Length غير صحيح');
  });

  await test('Range كلاحقة bytes=-500 يعيد آخر 500 بايت', async () => {
    const r = await fetch(`${BASE}/api/jobs/${upJobId}/video`, { headers: { Range: 'bytes=-500' } });
    assert(r.status === 206, `رمز ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const size = Number(r.headers.get('content-range').split('/')[1]);
    assert(buf.length === 500 && r.headers.get('content-range') === `bytes ${size - 500}-${size - 1}/${size}`, 'لاحقة Range غير صحيحة');
  });

  await test('Range غير صالح → 416 مع Content-Range bytes */size', async () => {
    const r = await fetch(`${BASE}/api/jobs/${upJobId}/video`, { headers: { Range: 'bytes=abc' } });
    assert(r.status === 416, `رمز ${r.status}`);
    assert(r.headers.get('content-range').startsWith('bytes */'), 'Content-Range للـ416 مفقود');
    const r2 = await fetch(`${BASE}/api/jobs/${upJobId}/video`, { headers: { Range: `bytes=999999999-` } });
    assert(r2.status === 416, `start>=size → رمز ${r2.status}`);
  });

  await test('?download=1 يضيف Content-Disposition: attachment', async () => {
    const r = await fetch(`${BASE}/api/jobs/${upJobId}/video?download=1`, { headers: { Range: 'bytes=0-99' } });
    assert(r.status === 206, `رمز ${r.status}`);
    assert(/attachment/.test(r.headers.get('content-disposition') || ''), 'Content-Disposition مفقود');
    await r.arrayBuffer();
  });

  await test('بث كامل بدون Range → 200 بطول الملف كامل', async () => {
    const r = await fetch(`${BASE}/api/jobs/${upJobId}/video`);
    assert(r.status === 200, `رمز ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const st = await req('GET', `/api/jobs/${upJobId}`);
    assert(buf.length === st.json.size, `الطول ${buf.length} مقابل ${st.json.size}`);
  });

  // ===== أخطاء الحالة والرفع =====
  await test('404 لمهمة غير موجودة (GET/status وvideo)', async () => {
    const r = await req('GET', '/api/jobs/does-not-exist-123');
    assert(r.status === 404 && r.json && r.json.error, `رمز ${r.status}`);
    const r2 = await fetch(`${BASE}/api/jobs/does-not-exist-123/video`);
    assert(r2.status === 404, `video رمز ${r2.status}`);
  });

  await test('رفع جزء > 4MB → 413، ورفع لمهمة غير موجودة → 404', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ sources: [{ kind: 'file', name: 'chunk-limit.mp4', size: 100, mime: 'video/mp4' }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    createdJobs.push(c.json.jobId);
    const big = Buffer.alloc(UPLOAD_CHUNK_BYTES + 100, 1);
    const r = await req('POST', `/api/upload?job=${c.json.jobId}&seq=0&chunk=0`, { body: big });
    assert(r.status === 413, `رمز ${r.status}`);
    assert(r.json && /تجاوز/.test(r.json.error), 'رسالة غير عربية');
    const r2 = await req('POST', `/api/upload?job=missing-job&seq=0&chunk=0`, { body: Buffer.alloc(10, 1) });
    assert(r2.status === 404, `رمز ${r2.status}`);
  });

  await test('رفع جزء يتجاوز الحجم المعلن → 413', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ sources: [{ kind: 'file', name: 'tiny.mp4', size: 100, mime: 'video/mp4' }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    createdJobs.push(c.json.jobId);
    const r = await req('POST', `/api/upload?job=${c.json.jobId}&seq=0&chunk=0`, { body: Buffer.alloc(200, 1) });
    assert(r.status === 413, `رمز ${r.status}`);
    assert(r.json && /تجاوز/.test(r.json.error), 'رسالة غير عربية');
  });

  await test('process على مهمة لم يكتمل رفعها → 409 برسالة عربية', async () => {
    const c = await req('POST', '/api/jobs', {
      body: JSON.stringify({ sources: [
        { kind: 'file', name: 'partial.mp4', size: 5000, mime: 'video/mp4' },
        { kind: 'file', name: 'partial2.mp4', size: 5000, mime: 'video/mp4' },
      ] }),
      headers: { 'Content-Type': 'application/json' },
    });
    createdJobs.push(c.json.jobId);
    // نرفع جزءًا واحدًا فقط من المصدر الأول
    await req('POST', `/api/upload?job=${c.json.jobId}&seq=0&chunk=0`, { body: Buffer.alloc(2000, 1) });
    const p = await req('POST', `/api/jobs/${c.json.jobId}/process`);
    assert(p.status === 409, `رمز ${p.status}`);
    assert(/لم يكتمل رفع/.test(p.json.error), `الرسالة: ${p.json.error}`);
  });

  await test('DELETE ثم GET → 404 وvideo → 404', async () => {
    const d = await req('DELETE', `/api/jobs/${mixJobId}`);
    assert(d.status === 200 && d.json.ok === true, `رمز ${d.status}`);
    const g = await req('GET', `/api/jobs/${mixJobId}`);
    assert(g.status === 404, `GET بعد الحذف: ${g.status}`);
    const v = await fetch(`${BASE}/api/jobs/${mixJobId}/video`);
    assert(v.status === 404, `video بعد الحذف: ${v.status}`);
    const idx = createdJobs.indexOf(mixJobId);
    if (idx >= 0) createdJobs.splice(idx, 1);
  });

  await test('GET /api/cron يعمل ويعيد deleted', async () => {
    const r = await req('GET', '/api/cron');
    assert(r.status === 200 && r.json && r.json.ok === true && Number.isInteger(r.json.deleted), `رمز ${r.status}`);
  });

  // ===== التنظيف الإلزامي: حذف كل المهام الاختبارية من Turso =====
  console.log('\n— تنظيف المهام الاختبارية —');
  for (const id of [...createdJobs]) {
    try {
      const d = await req('DELETE', `/api/jobs/${id}`);
      console.log(`  حذف ${id.slice(0, 8)}… → ${d.status}`);
      if (d.status === 200) {
        const idx = createdJobs.indexOf(id);
        if (idx >= 0) createdJobs.splice(idx, 1);
      }
    } catch (e) { console.log(`  فشل حذف ${id}: ${e.message}`); }
  }
  await test('لا تبقى أي صفوف اختبار في Turso', async () => {
    for (const id of createdJobs) {
      const r = await req('GET', `/api/jobs/${id}`);
      assert(r.status === 404, `المهمة ${id} ما تزال موجودة`);
    }
    assert(createdJobs.length === 0, `مهام لم تُحذف: ${createdJobs.length}`);
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* لا شيء */ }

  console.log(`\n=== النتيجة: PASS=${pass} | FAIL=${fail} ===`);
  if (fail) {
    console.log('الاختبارات الفاشلة:');
    failures.forEach((f) => console.log('  - ' + f));
  }
})().catch((e) => {
  console.error('خطأ كارثي في سكربت الاختبار:', e);
  fail++;
  failures.push('كارثي: ' + e.message);
}).finally(async () => {
  // إيقاف الخوادم في كل الأحوال + تنظيف أخير للمهام المتبقية
  for (const id of createdJobs) {
    try { await req('DELETE', `/api/jobs/${id}`); } catch { /* لا شيء */ }
  }
  if (devServer) { try { devServer.kill('SIGKILL'); } catch { /* لا شيء */ } }
  if (fileServer) { try { fileServer.close(); } catch { /* لا شيء */ } }
  setTimeout(() => {
    console.log(fail ? 'EXIT=1' : 'EXIT=0');
    process.exit(fail ? 1 : 0);
  }, 300);
});
