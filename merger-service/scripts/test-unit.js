'use strict';
/**
 * scripts/test-unit.js — اختبارات وحدة بدون خادم HTTP:
 * 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg ودمجهما عبر lib/merge.js مباشرة.
 * 2) التحقق: الدقة = أكبر دقة مدخل، المدة ≈ المجموع ±1، وجود مسار صوت، تقدم ترميز حقيقي.
 * 3) التخزين في Turso: كتابة blob ~5MB وقراءته بتطابق sha256 + قراءة مدى.
 * 4) حدود الحجم (رفض مصدر > SOURCE_MAX_MB عبر اختبار المنطق).
 * 5) الحذف الشامل من كل الجداول + التنظيف الكسول للمهام المنتهية.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const merge = require('../lib/merge');
const storage = require('../lib/storage');
const db = require('../lib/db');
const { limits } = require('../lib/env');

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

const FFMPEG = merge.getFfmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merger-unit-'));
const jobIdsToClean = [];

function generateVideo(dest, opts) {
  // توليد فيديو اختباري عبر ffmpeg-static (وفق المواصفة: نعتمد ffmpeg-static في الكود)
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (opts.audio) {
    args.push('-f', 'lavfi', '-i', `testsrc=duration=${opts.duration}:size=${opts.size}:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${opts.duration}`);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest');
  } else {
    args.push('-f', 'lavfi', '-i', `testsrc2=duration=${opts.duration}:size=${opts.size}:rate=30`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  }
  args.push(dest);
  execFileSync(FFMPEG, args, { stdio: 'pipe' });
}

(async () => {
  console.log('=== اختبارات الوحدة (test-unit.js) ===\n');
  await db.initSchema();

  const v1 = path.join(tmp, 'v1_640x360_3s.mp4');   // مع صوت sine
  const v2 = path.join(tmp, 'v2_1280x720_4s.mp4');  // بلا صوت
  let probes = null;
  const outPath = path.join(tmp, 'merged.mp4');
  const progressValues = [];

  await test('توليد فيديوهين مختلفي الدقة بـ ffmpeg', async () => {
    generateVideo(v1, { duration: 3, size: '640x360', audio: true });
    generateVideo(v2, { duration: 4, size: '1280x720', audio: false });
    assert(fs.existsSync(v1) && fs.existsSync(v2), 'الملفات المولدة غير موجودة');
    probes = [await merge.probeVideo(v1), await merge.probeVideo(v2)];
    assert(probes[0].width === 640 && probes[0].hasAudio === true, 'probe للمصدر الأول غير صحيح');
    assert(probes[1].width === 1280 && probes[1].hasAudio === false, 'probe للمصدر الثاني غير صحيح');
  });

  await test('دمج مباشر عبر lib/merge.js يكتمل', async () => {
    await merge.mergeFiles({
      inputs: [v1, v2], probes, outPath,
      preset: limits.ffmpegPreset, width: 1280, height: 720,
      onProgress: (frac) => progressValues.push(frac),
    });
    assert(fs.existsSync(outPath) && fs.statSync(outPath).size > 0, 'ملف الناتج مفقود أو فارغ');
  });

  await test('التقدم من -progress pipe:1 يُقرأ فعلًا', async () => {
    const maxFrac = Math.max(...progressValues);
    assert(maxFrac > 0.3, `أقصى نسبة مقروءة = ${maxFrac} — قراءة out_time_us لا تعمل`);
  });

  await test('الدقة الناتجة = أكبر دقة مدخل (1280x720)', async () => {
    const p = await merge.probeVideo(outPath);
    assert(p.width === 1280 && p.height === 720, `الدقة الفعلية ${p.width}x${p.height}`);
  });

  await test('المدة ≈ مجموع المدد (7ث ±1)', async () => {
    const p = await merge.probeVideo(outPath);
    const total = probes[0].duration + probes[1].duration;
    assert(Math.abs(p.duration - total) <= 1, `المدة ${p.duration.toFixed(2)} مقابل المتوقع ${total.toFixed(2)}`);
  });

  await test('وجود مسار صوت في الناتج رغم مصدر صامت', async () => {
    const p = await merge.probeVideo(outPath);
    assert(p.hasAudio === true, 'لا يوجد مسار صوت في الناتج');
  });

  // ===== اختبارات التخزين في Turso =====
  const testJobId = 'unit-test-' + crypto.randomBytes(8).toString('hex');
  jobIdsToClean.push(testJobId);

  await test('كتابة blob ~5MB في output_chunks وقراءته بتطابق sha256', async () => {
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123456); // حجم غير مضاعف لاختبار الصف الأخير
    await db.createJob(
      { id: testJobId, status: 'processing', created_at: db.nowIso(), expires_at: db.expiryIso() },
      [{ seq: 0, kind: 'url', url: 'https://example.com/x.mp4' }]
    );
    await storage.writeOutputBlob(testJobId, big);
    const readBack = await storage.readAllOutput(testJobId);
    const h1 = crypto.createHash('sha256').update(big).digest('hex');
    const h2 = crypto.createHash('sha256').update(readBack).digest('hex');
    assert(h1 === h2, `عدم تطابق sha256 (${readBack.length} بايت قراءة مقابل ${big.length})`);
    // قراءة مدى وسطي والتحقق من تطابقها بايت-بايت (المدى شامل الطرفين: start..end)
    const rangeStart = 2_000_000, rangeEnd = 2_524_288;
    const slice = await storage.readOutputRange(testJobId, rangeStart, rangeEnd);
    assert(slice.equals(big.subarray(rangeStart, rangeEnd + 1)), 'قراءة المدى لا تطابق الأصل');
  });

  await test('بث مدى عبر streamOutputRange يقصّ أول/آخر جزء بدقة', async () => {
    // نستخدم استجابة وهمية بسيطة لالتقاط البايتات المكتوبة
    const big = Buffer.alloc(3 * 1024 * 1024 + 777, 9);
    const id2 = testJobId + '-range';
    jobIdsToClean.push(id2);
    await db.createJob(
      { id: id2, status: 'done', created_at: db.nowIso(), expires_at: db.expiryIso(), output_size: big.length },
      []
    );
    await storage.writeOutputBlob(id2, big);
    const captured = [];
    const fakeRes = {
      write(b) { captured.push(Buffer.from(b)); return true; },
      once() {}, on() {},
    };
    const sent = await storage.streamOutputRange(id2, 100, 2_097_152 + 500, fakeRes, big.length);
    const out = Buffer.concat(captured);
    assert(sent === out.length && out.equals(big.subarray(100, 2_097_152 + 501)), 'مدى البث لا يطابق القص المتوقع');
  });

  await test('حدود الحجم: رفض مصدر يتجاوز SOURCE_MAX_MB (اختبار المنطق)', async () => {
    const original = process.env.SOURCE_MAX_MB;
    try {
      process.env.SOURCE_MAX_MB = '0.0001'; // ~104 بايت — أي مصدر حقيقي يُرفض فورًا
      let threw = null;
      try { merge.enforceSourceSize(1024, 'ملف اختبار'); } catch (e) { threw = e; }
      assert(threw, 'لم يُرمَ خطأ عند تجاوز الحد');
      assert(threw.statusCode === 413, `كود الخطأ ${threw.statusCode} بدل 413`);
      assert(/يتجاوز الحد المسموح/.test(threw.message), 'الرسالة ليست بالعربية المتوقعة');
      // نفس المنطق يُستخدم أثناء التنزيل — نتأكد أنه يرفض صراحةً
      let threw2 = null;
      try { merge.enforceSourceSize(limits.sourceMaxBytes + 1, 'رابط'); } catch (e) { threw2 = e; }
      assert(threw2 && threw2.isBiz, 'الحد الفعلي من البيئة لا يُطبَّق');
    } finally {
      process.env.SOURCE_MAX_MB = original; // استعادة القيمة الأصلية دائمًا
    }
  });

  await test('الحذف الشامل يفرّغ كل الجداول', async () => {
    const check = async (sql) => {
      const r = await db.getDb().execute({ sql, args: [testJobId] });
      return Number(r.rows[0] && r.rows[0].n) || 0;
    };
    // تأكد أن هناك صفوف أولًا
    const before = await check('SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?');
    assert(before > 0, 'لا توجد صفوف ناتج للحذف أصلاً');
    await db.deleteJob(testJobId);
    const jobs = await check('SELECT COUNT(*) AS n FROM jobs WHERE id = ?');
    const sources = await check('SELECT COUNT(*) AS n FROM sources WHERE job_id = ?');
    const sChunks = await check('SELECT COUNT(*) AS n FROM source_chunks WHERE job_id = ?');
    const oChunks = await check('SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?');
    assert(jobs === 0 && sources === 0 && sChunks === 0 && oChunks === 0,
      `بقيت صفوف: jobs=${jobs} sources=${sources} source_chunks=${sChunks} output_chunks=${oChunks}`);
    const idx = jobIdsToClean.indexOf(testJobId);
    if (idx >= 0) jobIdsToClean.splice(idx, 1); // حُذفت بالفعل
  });

  await test('التنظيف الكسول يحذف المهام المنتهية الصلاحية', async () => {
    const expiredId = testJobId + '-expired';
    jobIdsToClean.push(expiredId);
    await db.createJob(
      { id: expiredId, status: 'done', created_at: db.nowIso(), expires_at: new Date(Date.now() - 1000).toISOString() },
      []
    );
    await storage.writeOutputBlob(expiredId, Buffer.alloc(1024, 1));
    const deleted = await db.cleanupExpired();
    const r = await db.getDb().execute({ sql: 'SELECT COUNT(*) AS n FROM jobs WHERE id = ?', args: [expiredId] });
    assert(Number(r.rows[0].n) === 0, 'المهمة المنتهية لم تُحذف');
    const idx = jobIdsToClean.indexOf(expiredId);
    if (idx >= 0) jobIdsToClean.splice(idx, 1);
  });

  // ===== تنظيف نهائي لأي صفوف اختبار متبقية =====
  for (const id of jobIdsToClean) {
    try { await db.deleteJob(id); } catch { /* لا شيء */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* لا شيء */ }

  console.log(`\n=== النتيجة: PASS=${pass} | FAIL=${fail} ===`);
  if (fail) {
    console.log('الاختبارات الفاشلة:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('خطأ كارثي في سكربت الاختبار:', e);
  process.exit(1);
});
