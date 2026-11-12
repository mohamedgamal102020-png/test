'use strict';
/**
 * lib/db.js — طبقة Turso (libSQL): الاتصال، إنشاء المخطط، وعمليات المهام المشتركة.
 * كل شيء يُخزَّن في Turso: بيانات المهام، أجزاء المصادر، والفيديو الناتج (Blobs).
 */
const { createClient } = require('@libsql/client');
const { loadEnv, OUTPUT_TTL_MS } = require('./env');

loadEnv(); // تحميل .env يدويًا إن لزم

let _db = null;
let _initPromise = null;

/** إنشاء/إرجاع عميل Turso وحيد لكل نسخة دالة (Connection caching) */
function getDb() {
  if (_db) return _db;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    const err = new Error('متغير البيئة TURSO_DATABASE_URL غير مضبوط');
    err.statusCode = 500;
    throw err;
  }
  // قواعد الملفات المحلية لا تحتاج توكن؛ القواعد البعيدة (libsql://) تحتاجه
  const opts = url.startsWith('file:') ? { url } : { url, authToken: process.env.TURSO_AUTH_TOKEN };
  _db = createClient(opts);
  return _db;
}

/** إنشاء الجداول إن لم تكن موجودة — تُستدعى مرة واحدة لكل نسخة دالة */
function initSchema() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = getDb();
    // ملاحظة: أضفنا عمود received لتتبع البايتات المستلمة فعليًا لكل مصدر مرفوع
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT,
        progress INTEGER DEFAULT 0,
        sources_json TEXT,
        output_url TEXT,
        output_size INTEGER,
        output_duration REAL,
        output_resolution TEXT,
        error TEXT,
        created_at TEXT,
        expires_at TEXT
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT,
        seq INTEGER,
        kind TEXT,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        uploaded INTEGER DEFAULT 0,
        received INTEGER DEFAULT 0,
        PRIMARY KEY(job_id, seq)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT,
        seq INTEGER,
        chunk INTEGER,
        data BLOB,
        PRIMARY KEY(job_id, seq, chunk)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT,
        chunk INTEGER,
        data BLOB,
        PRIMARY KEY(job_id, chunk)
      )` },
    ], 'write');
  })();
  // لا نسمح بانتشار أخطاء مخزّنة عبر الوعد المخزّن مؤقتًا — أعد المحاولة في الاستدعاء القادم
  _initPromise.catch(() => { _initPromise = null; });
  return _initPromise;
}

/** الوقت الحالي بصيغة ISO-8601 UTC (مقارنة نصية صحيحة زمنيًا في SQLite) */
function nowIso() { return new Date().toISOString(); }

/** حساب وقت انتهاء الصلاحية = الآن + 24 ساعة */
function expiryIso(from = Date.now()) { return new Date(from + OUTPUT_TTL_MS).toISOString(); }

/** جلب مهمة واحدة أو null */
async function getJob(id) {
  const r = await getDb().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return r.rows.length ? r.rows[0] : null;
}

/** جلب مصادر المهمة مرتبة بترتيب الدمج */
async function getSources(jobId) {
  const r = await getDb().execute({
    sql: 'SELECT job_id, seq, kind, url, name, size, mime, uploaded, received FROM sources WHERE job_id = ? ORDER BY seq',
    args: [jobId],
  });
  return r.rows;
}

/** جلب مصدر واحد */
async function getSource(jobId, seq) {
  const r = await getDb().execute({
    sql: 'SELECT job_id, seq, kind, url, name, size, mime, uploaded, received FROM sources WHERE job_id = ? AND seq = ?',
    args: [jobId, seq],
  });
  return r.rows.length ? r.rows[0] : null;
}

/** إنشاء مهمة + مصادرها في دفعة واحدة (ذرّية) */
async function createJob(job, sources) {
  const db = getDb();
  const stmts = [{
    sql: `INSERT INTO jobs (id, status, progress, sources_json, created_at, expires_at)
          VALUES (?, ?, 0, ?, ?, ?)`,
    args: [job.id, job.status, JSON.stringify(sources || []), job.created_at, job.expires_at],
  }];
  for (const s of sources || []) {
    stmts.push({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, uploaded, received)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      args: [job.id, s.seq, s.kind, s.url || null, s.name || null, s.size || null, s.mime || null],
    });
  }
  await db.batch(stmts, 'write');
}

/** تحديث أعمدة المهمة ديناميكيًا */
async function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await getDb().execute({
    sql: `UPDATE jobs SET ${sets} WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), id],
  });
}

/**
 * حجز المهمة للمعالجة بشكل تنافسي (Claim): تنجح فقط إذا كانت في حالة قابلة للمعالجة.
 * هذا يمنع سباق استدعاءين متزامنين لـ process — الأول يحجز والثاني يرى processing → 202.
 */
async function claimForProcessing(id) {
  const r = await getDb().execute({
    sql: `UPDATE jobs SET status = 'processing', progress = 0, error = NULL
          WHERE id = ? AND status IN ('queued', 'uploading', 'failed')`,
    args: [id],
  });
  return r.rowsAffected > 0;
}

/** زيادة عدد البايتات المستلمة لمصدر مرفوع وتحديد اكتماله */
async function addSourceReceived(jobId, seq, bytes, declaredSize) {
  const src = await getSource(jobId, seq);
  if (!src) return null;
  const received = (src.received || 0) + bytes;
  const uploaded = declaredSize != null && received >= declaredSize ? 1 : (src.uploaded || 0);
  await getDb().execute({
    sql: 'UPDATE sources SET received = ?, uploaded = ? WHERE job_id = ? AND seq = ?',
    args: [received, uploaded, jobId, seq],
  });
  return { received, uploaded };
}

/**
 * حذف فوري شامل لكل صفوف المهمة (jobs + sources + source_chunks + output_chunks)
 * في دفعة واحدة عبر db.batch — قرار مهم لضمان عدم بقاء أي أثر.
 */
async function deleteJob(id) {
  const db = getDb();
  await db.batch([
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
  ], 'write');
}

/** التنظيف الكسول: حذف كل المهام المنتهية الصلاحية وأجزائها — يُستدعى عند الإنشاء/الدمج والـ Cron */
async function cleanupExpired() {
  const db = getDb();
  const r = await db.execute({ sql: 'SELECT id FROM jobs WHERE expires_at <= ?', args: [nowIso()] });
  const ids = r.rows.map((row) => row.id);
  if (!ids.length) return 0;
  const stmts = [];
  for (const id of ids) {
    stmts.push({ sql: 'DELETE FROM jobs WHERE id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] });
  }
  await db.batch(stmts, 'write');
  return ids.length;
}

module.exports = {
  getDb,
  initSchema,
  nowIso,
  expiryIso,
  getJob,
  getSources,
  getSource,
  createJob,
  updateJob,
  claimForProcessing,
  addSourceReceived,
  deleteJob,
  cleanupExpired,
};
