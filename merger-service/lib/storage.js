'use strict';
/**
 * lib/storage.js — تخزين وقراءة Blobs من Turso:
 * - كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso).
 * - القراءة تتم بتدفّق بصفحات من 8 صفوف.
 * - أجزاء الرفع القادمة من العميل (≤4MB) تُخزَّن داخل صفوف 2MB بمفتاح فرعي k*10+sub
 *   لأن المفتاح الأساسي (job_id, seq, chunk) لا يسمح بصفوف متعددة لنفس رقم الجزء.
 */
const fs = require('fs');
const { getDb } = require('./db');
const { CHUNK_ROW_BYTES, READ_PAGE_ROWS } = require('./env');

/** تحويل قيمة BLOB القادمة من libsql (ArrayBuffer أو Uint8Array) إلى Buffer */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

/** كتابة جزء مصدر مرفوع: يقسم الجزء (≤4MB) إلى صفوف 2MB بمفاتيح k*10+sub */
async function writeSourceChunk(jobId, seq, chunkIndex, buffer) {
  const db = getDb();
  const base = chunkIndex * 10; // كل جزء ≤4MB يعطي صفين كحد أقصى، فلا تصادم بين الأجزاء
  const stmts = [];
  for (let offset = 0, sub = 0; offset < buffer.length; offset += CHUNK_ROW_BYTES, sub++) {
    stmts.push({
      sql: 'INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)',
      args: [jobId, seq, base + sub, buffer.subarray(offset, Math.min(offset + CHUNK_ROW_BYTES, buffer.length))],
    });
  }
  if (!stmts.length) return;
  // إعادة محاولة رفع نفس الجزء تستبدل الصفوف القديمة (استبدال غير متضارب)
  await db.batch([
    { sql: 'DELETE FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? AND chunk < ?',
      args: [jobId, seq, base, base + 10] },
    ...stmts,
  ], 'write');
}

/** الحجم المخزّن فعليًا لجزء معيّن (مفيد عند إعادة رفع نفس الجزء لضبط العدّ) */
async function getStoredChunkSize(jobId, seq, chunkIndex) {
  const base = chunkIndex * 10;
  const r = await getDb().execute({
    sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? AND chunk < ?',
    args: [jobId, seq, base, base + 10],
  });
  return Number(r.rows[0] && r.rows[0].n) || 0;
}

/** كتابة الفيديو الناتج بالكامل: صفوف 2MB متتالية (0,1,2,...) بأحجام موحّدة إلا الأخير */
async function writeOutputBlob(jobId, buffer) {
  const db = getDb();
  // تنظيف أي ناتج قديم لنفس المهمة قبل الكتابة
  await db.execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
  const rows = [];
  for (let offset = 0, i = 0; offset < buffer.length; offset += CHUNK_ROW_BYTES, i++) {
    rows.push({
      sql: 'INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)',
      args: [jobId, i, buffer.subarray(offset, Math.min(offset + CHUNK_ROW_BYTES, buffer.length))],
    });
  }
  // إدخال بدفعات صغيرة لتجنب تجاوز حجم طلب HTTP الواحد إلى Turso
  const BATCH = 3;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(rows.slice(i, i + BATCH), 'write');
  }
}

/** قراءة صفوف output_chunks صفحةً صفحة (8 صفوف) وتطبيق دالة على كل صف (Buffer) */
async function forEachOutputRow(jobId, startChunk, endChunk, onData) {
  const db = getDb();
  let cursor = startChunk;
  while (cursor <= endChunk) {
    const r = await db.execute({
      sql: 'SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? AND chunk <= ? ORDER BY chunk LIMIT ?',
      args: [jobId, cursor, endChunk, READ_PAGE_ROWS],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      await onData(row.chunk, toBuffer(row.data));
    }
    const last = r.rows[r.rows.length - 1].chunk;
    if (last < cursor) break; // حماية من حلقة لا نهائية
    cursor = last + 1;
    if (r.rows.length < READ_PAGE_ROWS) break;
  }
}

/**
 * بث مدى بايتات [start..end] من الفيديو الناتج إلى استجابة HTTP.
 * المسار السريع: الصفوف موحّدة الحجم (2MB) فيُحسب رقم الصف رياضيًا ويُقصّ أول/آخر جزء حسب المدى.
 * المسار الاحتياطي الخطي: لو اختل التسلسل/الأحجام نمرّ من الصفر مع تتبّع الإزاحات (صحيح دائمًا).
 */
async function streamOutputRange(jobId, start, end, res, totalSize) {
  const ROW = CHUNK_ROW_BYTES;
  const startRow = Math.floor(start / ROW);
  const endRow = Math.floor(end / ROW);

  // مسار تحقق أولي (دون كتابة): نتأكد أن الصفوف متسلسلة وموحّدة الحجم
  let valid = true;
  let expected = startRow;
  await forEachOutputRow(jobId, startRow, endRow, async (chunk, data) => {
    if (chunk !== expected) valid = false;
    expected = chunk + 1;
    const isLastOfBlob = chunk * ROW + data.length >= totalSize;
    if (data.length !== ROW && !isLastOfBlob) valid = false;
  });

  if (valid) {
    let sent = 0;
    await forEachOutputRow(jobId, startRow, endRow, async (chunk, data) => {
      const rowStart = chunk * ROW;
      const rowEnd = rowStart + data.length - 1;
      const s = Math.max(start, rowStart);
      const e = Math.min(end, rowEnd);
      if (e < s) return;
      const slice = data.subarray(s - rowStart, e - rowStart + 1);
      sent += slice.length;
      if (!res.write(slice)) {
        // ضغط تدفق الإرسال للعميل حتى لا يتضخم استهلاك الذاكرة
        await new Promise((resolve) => res.once('drain', resolve));
      }
    });
    return sent;
  }

  // مسار احتياطي خطي: يعمل مع أي توزيع لأحجام الصفوف
  let sent = 0;
  let pos = 0;
  await forEachOutputRow(jobId, 0, Number.MAX_SAFE_INTEGER, async (chunk, data) => {
    if (pos > end) return;
    const rowEnd = pos + data.length - 1;
    if (rowEnd < start) { pos += data.length; return; }
    const s = Math.max(start, pos);
    const e = Math.min(end, rowEnd);
    const slice = data.subarray(s - pos, e - pos + 1);
    sent += slice.length;
    if (!res.write(slice)) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
    pos += data.length;
  });
  return sent;
}

/** قراءة الفيديو الناتج كاملًا في الذاكرة — مخصصة للاختبارات */
async function readAllOutput(jobId) {
  const parts = [];
  await forEachOutputRow(jobId, 0, Number.MAX_SAFE_INTEGER, async (chunk, data) => {
    parts[chunk] = data;
  });
  return Buffer.concat(parts.map((p) => p));
}

/** قراءة مدى محدد من الناتج (للاختبارات) */
async function readOutputRange(jobId, start, end) {
  const ROW = CHUNK_ROW_BYTES;
  const chunks = [];
  await forEachOutputRow(jobId, Math.floor(start / ROW), Math.floor(end / ROW), async (chunk, data) => {
    const rowStart = chunk * ROW;
    const rowEnd = rowStart + data.length - 1;
    const s = Math.max(start, rowStart);
    const e = Math.min(end, rowEnd);
    if (e >= s) chunks.push(data.subarray(s - rowStart, e - rowStart + 1));
  });
  return Buffer.concat(chunks);
}

/**
 * تجميع أجزاء مصدر مرفوع من قاعدة البيانات إلى ملف مؤقت (تدفّقًا)،
 * مع فرض حد الحجم أثناء القراءة — تجاوزه = فشل فوري واضح برسالة عربية.
 */
async function assembleSourceToFile(jobId, seq, destPath, maxBytes) {
  const db = getDb();
  const out = fs.createWriteStream(destPath);
  let bytes = 0;
  let exceeded = false;
  let cursor = -1;
  try {
    while (true) {
      const r = await db.execute({
        sql: 'SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk > ? ORDER BY chunk LIMIT ?',
        args: [jobId, seq, cursor, READ_PAGE_ROWS],
      });
      if (!r.rows.length) break;
      for (const row of r.rows) {
        const data = toBuffer(row.data);
        bytes += data.length;
        if (bytes > maxBytes) { exceeded = true; break; } // عدّ فوري للبايتات — لا ننتظر النهاية
        cursor = row.chunk;
        if (!out.write(data)) await new Promise((resolve) => out.once('drain', resolve));
      }
      if (exceeded || r.rows.length < READ_PAGE_ROWS) break;
    }
    await new Promise((resolve) => out.end(resolve));
  } finally {
    out.destroy();
  }
  if (exceeded) {
    try { fs.unlinkSync(destPath); } catch { /* لا شيء */ }
    const err = new Error(`حجم المصدر المرفوع يتجاوز الحد المسموح (${Math.floor(maxBytes / (1024 * 1024))}MB)`);
    err.statusCode = 413;
    throw err;
  }
  return bytes;
}

module.exports = {
  toBuffer,
  writeSourceChunk,
  getStoredChunkSize,
  writeOutputBlob,
  forEachOutputRow,
  streamOutputRange,
  readAllOutput,
  readOutputRange,
  assembleSourceToFile,
};
