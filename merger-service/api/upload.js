'use strict';
/**
 * api/upload.js — POST /api/upload?job=<id>&seq=<n>&chunk=<k>
 * رفع ثنائي لجزء واحد ≤4MB يُقسَّم داخليًا إلى صفوف 2MB في Turso، مع تحقق من الحدود والحالة.
 */
const db = require('../lib/db');
const storage = require('../lib/storage');
const { UPLOAD_CHUNK_BYTES } = require('../lib/env');
const {
  sendJson, sendError, handleOptions, readBody, respondWithError, jsonError,
} = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم POST لرفع الأجزاء');

  try {
    await db.initSchema();
    const q = req.query || {};
    const jobId = String(q.job || '');
    const seq = Number(q.seq);
    const chunk = Number(q.chunk);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      throw jsonError(400, 'معاملات الرفع غير صالحة — يلزم job و seq و chunk أرقام صحيحة');
    }

    const job = await db.getJob(jobId);
    if (!job) throw jsonError(404, 'المهمة غير موجودة');
    if (job.status !== 'queued' && job.status !== 'uploading') {
      throw jsonError(409, 'المهمة لم تعد تقبل رفع الملفات في وضعها الحالي');
    }

    const source = await db.getSource(jobId, seq);
    if (!source) throw jsonError(404, 'المصدر المطلوب غير موجود في هذه المهمة');
    if (source.kind !== 'file') throw jsonError(400, 'هذا المصدر رابط وليس ملفًا — لا يُقبل رفع أجزاء له');

    // جزء ثنائي واحد ≤4MB (نضيف سماحية صغيرة لتجاوز التحقق برسالة أدق)
    const body = await readBody(req, { maxBytes: UPLOAD_CHUNK_BYTES + 1024 });
    if (body.length > UPLOAD_CHUNK_BYTES) {
      throw jsonError(413, 'حجم الجزء يتجاوز الحد المسموح (4MB لكل جزء)');
    }

    const declared = source.size || 0;
    // لو أُعيد رفع نفس الجزء (فقدان استجابة سابقًا) نحسب الفارق فقط ليبقى العدّ دقيقًا
    const prevBytes = await storage.getStoredChunkSize(jobId, seq, chunk);
    const newTotal = (source.received || 0) - prevBytes + body.length;
    if (declared && newTotal > declared) {
      throw jsonError(413, 'البايتات المرفوعة تتجاوز الحجم المعلن للملف');
    }

    await storage.writeSourceChunk(jobId, seq, chunk, body);
    const upd = await db.addSourceReceived(jobId, seq, body.length - prevBytes, declared);

    sendJson(res, 200, {
      ok: true,
      jobId,
      seq,
      chunk,
      receivedBytes: upd ? upd.received : body.length,
      sizeBytes: declared,
      complete: Boolean(upd && upd.uploaded),
    });
  } catch (e) {
    respondWithError(res, e);
  }
};
