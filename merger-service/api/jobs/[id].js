'use strict';
/**
 * api/jobs/[id].js — GET /api/jobs/<id>: الحالة + التقدم (0–100) + الرابط عند الاكتمال.
 *                    DELETE /api/jobs/<id>: حذف فوري شامل لكل صفوف المهمة.
 */
const db = require('../../lib/db');
const {
  sendJson, sendError, handleOptions, getOrigin, respondWithError, jsonError,
} = require('../../lib/http');

/** بناء ردّ الحالة الموحّد (يُستخدم أيضًا عند الاستئناف بعد تحديث الصفحة) */
function jobPayload(job, sources, origin) {
  const payload = {
    jobId: job.id,
    status: job.status,
    progress: Number(job.progress || 0),
    error: job.error || null,
    createdAt: job.created_at,
    expiresAt: job.expires_at,
    sources: sources.map((s) => ({
      seq: Number(s.seq),
      kind: s.kind,
      url: s.url || null,
      name: s.name || null,
      size: s.size != null ? Number(s.size) : null,
      mime: s.mime || null,
      received: Number(s.received || 0),
      uploaded: Boolean(s.uploaded),
    })),
  };
  if (job.status === 'done') {
    payload.videoUrl = `${origin}/api/jobs/${job.id}/video`;
    payload.downloadUrl = `${origin}/api/jobs/${job.id}/video?download=1`;
    payload.size = Number(job.output_size || 0);
    payload.duration = Number(job.output_duration || 0);
    payload.resolution = job.output_resolution || null;
  }
  return payload;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);

  try {
    await db.initSchema();
    const id = String((req.query && req.query.id) || '');
    if (!id) throw jsonError(400, 'معرف المهمة مفقود');

    if (req.method === 'GET') {
      const job = await db.getJob(id);
      if (!job) throw jsonError(404, 'المهمة غير موجودة');
      const sources = await db.getSources(id);
      sendJson(res, 200, jobPayload(job, sources, getOrigin(req)));
      return;
    }

    if (req.method === 'DELETE') {
      const job = await db.getJob(id);
      if (!job) throw jsonError(404, 'المهمة غير موجودة');
      // حذف فوري شامل: jobs + sources + source_chunks + output_chunks في دفعة واحدة
      await db.deleteJob(id);
      sendJson(res, 200, { ok: true, deleted: true, jobId: id });
      return;
    }

    sendError(res, 405, 'طريقة الطلب غير مسموحة — المتاح: GET و DELETE');
  } catch (e) {
    respondWithError(res, e);
  }
};
