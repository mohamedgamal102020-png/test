'use strict';
/**
 * api/jobs/[id]/video.js — GET /api/jobs/<id>/video
 * بث الفيديو الناتج بدعم Range (206 + Content-Range + Accept-Ranges) للتقديم/الترجيع،
 * و?download=1 يضيف Content-Disposition: attachment. النطاق غير الصالح → 416.
 */
const db = require('../../../lib/db');
const storage = require('../../../lib/storage');
const {
  applyCors, sendError, handleOptions, respondWithError, jsonError,
} = require('../../../lib/http');

/** استجابة 416 موحّدة مع ترويسة Content-Range الصحيحة للنطاق المتاح */
function sendRangeNotSatisfiable(res, size, message) {
  applyCors(res);
  res.statusCode = 416;
  res.setHeader('Content-Range', `bytes */${size}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم GET لبث الفيديو');
  }

  try {
    await db.initSchema();
    const id = String((req.query && req.query.id) || '');
    if (!id) throw jsonError(400, 'معرف المهمة مفقود');

    const job = await db.getJob(id);
    if (!job) throw jsonError(404, 'المهمة غير موجودة');
    if (job.status !== 'done' || !job.output_size) {
      throw jsonError(404, 'النتيجة غير متوفرة بعد — المهمة لم تكتمل أو فشلت');
    }

    const size = Number(job.output_size);
    const rangeHeader = req.headers.range || '';
    let start = 0;
    let end = size - 1;
    let statusCode = 200;

    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        return sendRangeNotSatisfiable(res, size, 'نطاق البايتات المطلوب غير صالح');
      }
      if (m[1] === '') {
        // صيغة اللاحقة bytes=-N: آخر N بايت
        const suffix = Number(m[2]);
        if (!suffix || suffix <= 0) return sendRangeNotSatisfiable(res, size, 'نطاق البايتات المطلوب غير صالح');
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(m[1]);
        if (start >= size) return sendRangeNotSatisfiable(res, size, 'نطاق البايتات المطلوب يقع خارج حجم الملف');
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
        if (end < start) return sendRangeNotSatisfiable(res, size, 'نطاق البايتات المطلوب غير صالح');
      }
      statusCode = 206;
    }

    applyCors(res);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'no-store');
    if (statusCode === 206) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    if (String((req.query && req.query.download) || '') === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="merged-${id}.mp4"`);
    }
    if (req.method === 'HEAD') return res.end();

    // البث صفحةً صفحة من Turso مع قصّ أول/آخر جزء حسب المدى المطلوب
    await storage.streamOutputRange(id, start, end, res, size);
    res.end();
  } catch (e) {
    if (!res.headersSent) respondWithError(res, e);
    else res.destroy();
  }
};
