'use strict';
/**
 * api/jobs/[id]/process.js — POST /api/jobs/<id>/process
 * تنفيذ الدمج كاملًا بشكل متزامن (سحب ← ترميز ← حفظ) ويرجع النتيجة مباشرة.
 * إن كانت المهمة قيد المعالجة فعله يرجع 202، وإن كانت منتهية يرجع نتيجتها المحفوظة.
 */
const db = require('../../../lib/db');
const merge = require('../../../lib/merge');
const {
  sendJson, sendError, handleOptions, getOrigin, respondWithError, jsonError,
} = require('../../../lib/http');

/** ردّ النتيجة النهائية الموحّد (يُستخدم عند الاكتمال وعند إعادة الاستدعاء لمهمة منتهية) */
function donePayload(job, origin) {
  return {
    status: 'done',
    jobId: job.id,
    videoUrl: `${origin}/api/jobs/${job.id}/video`,
    downloadUrl: `${origin}/api/jobs/${job.id}/video?download=1`,
    size: Number(job.output_size || 0),
    duration: Number(job.output_duration || 0),
    resolution: job.output_resolution || null,
    expiresAt: job.expires_at,
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم POST لتنفيذ الدمج');

  try {
    await db.initSchema();
    // التنظيف الكسول عند كل دمج أيضًا (وفق المواصفة)
    await db.cleanupExpired();

    const id = String((req.query && req.query.id) || '');
    if (!id) throw jsonError(400, 'معرف المهمة مفقود');

    const job = await db.getJob(id);
    if (!job) throw jsonError(404, 'المهمة غير موجودة');

    const origin = getOrigin(req);
    if (job.status === 'done') {
      // النتيجة محفوظة بالفعل — نعيد دون إعادة ترميز
      sendJson(res, 200, donePayload(job, origin));
      return;
    }

    // حجز تنافسي: يمنع سباق استدعاءين متزامنين — الأول يعالج والثاني يرى 202
    const claimed = await db.claimForProcessing(id);
    if (!claimed) {
      const current = await db.getJob(id);
      if (current && current.status === 'processing') {
        sendJson(res, 202, { status: 'processing', jobId: id, statusUrl: `${origin}/api/jobs/${id}` });
        return;
      }
      if (current && current.status === 'done') {
        sendJson(res, 200, donePayload(current, origin));
        return;
      }
      throw jsonError(current ? 409 : 404, current ? 'حالة المهمة لا تسمح ببدء المعالجة' : 'المهمة غير موجودة');
    }

    try {
      // تنفيذ متزامن: ينزّل/يسحب المصادر ← يرمّز ← يحفظ — ويرجع مباشرة
      await merge.processJob(id);
      const fresh = await db.getJob(id);
      if (!fresh || fresh.status !== 'done') {
        // احتياط نظري: فشل صامت غير متوقع
        throw jsonError(fresh && fresh.error ? 500 : 500, (fresh && fresh.error) || 'انتهت المعالجة دون نتيجة');
      }
      sendJson(res, 200, donePayload(fresh, origin));
    } catch (e) {
      respondWithError(res, e); // الحالة خُزّنت failed مع رسالة عربية داخل processJob
    }
  } catch (e) {
    respondWithError(res, e);
  }
};
