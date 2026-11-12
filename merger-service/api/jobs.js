'use strict';
/**
 * api/jobs.js — POST /api/jobs: إنشاء مهمة دمج جديدة.
 * يقبل {"videos":["رابط",...]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * ويرجع 201 مع روابط الحالة والمعالجة وروابط رفع الأجزاء للملفات.
 */
const crypto = require('crypto');
const db = require('../lib/db');
const { limits, UPLOAD_CHUNK_BYTES } = require('../lib/env');
const {
  sendJson, sendError, handleOptions, getOrigin, readJsonBody, respondWithError, jsonError,
} = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم POST لإنشاء مهمة');

  try {
    await db.initSchema();
    // التنظيف الكسول: حذف المهام المنتهية الصلاحية عند كل إنشاء (نقطة حرجة وفق المواصفة)
    await db.cleanupExpired();

    const body = await readJsonBody(req, { maxBytes: 1024 * 1024 });

    // توحيد شكل المدخلات: videos[] روابط مباشرة أو sources[] مفصلة
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: 'url', url: String(u || '').trim() }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => {
        if (s && s.kind === 'file') {
          return { kind: 'file', name: String(s.name || 'file').slice(0, 300), size: Number(s.size || 0), mime: String(s.mime || '') };
        }
        return { kind: 'url', url: String((s && s.url) || '').trim() };
      });
    } else {
      throw jsonError(400, 'جسم الطلب يجب أن يحوي "videos" كمصفوفة روابط أو "sources" كمصفوفة مصادر');
    }

    // التحقق من صحة كل مصدر قبل الكتابة — رفض مبكر برسائل عربية وكود صحيح
    for (const s of sources) {
      if (s.kind === 'url') {
        if (!/^https?:\/\/.+/i.test(s.url)) throw jsonError(400, `رابط المصدر غير صالح: "${s.url.slice(0, 80) || 'فارغ'}"`);
      } else {
        if (!Number.isFinite(s.size) || s.size <= 0) throw jsonError(400, `حجم الملف "${s.name}" غير صالح`);
        if (s.size > limits.sourceMaxBytes) {
          throw jsonError(413, `حجم الملف "${s.name}" يتجاوز الحد المسموح (${limits.sourceMaxMB}MB لكل مصدر)`);
        }
      }
    }
    if (!sources.length) throw jsonError(400, 'أضف مصدرًا واحدًا على الأقل لإنشاء المهمة');
    if (sources.length > limits.maxSources) {
      throw jsonError(400, `عدد المصادر (${sources.length}) يتجاوز الحد الأقصى المسموح (${limits.maxSources})`);
    }

    const hasFiles = sources.some((s) => s.kind === 'file');
    const id = crypto.randomUUID();
    const created_at = db.nowIso();
    const expires_at = db.expiryIso();
    sources.forEach((s, i) => { s.seq = i; }); // ترتيب المصفوفة = ترتيب الدمج

    await db.createJob({ id, status: hasFiles ? 'uploading' : 'queued', created_at, expires_at }, sources);

    const origin = getOrigin(req);
    const resp = {
      jobId: id,
      status: hasFiles ? 'uploading' : 'queued',
      statusUrl: `${origin}/api/jobs/${id}`,
      processUrl: `${origin}/api/jobs/${id}/process`,
      expiresAt: expires_at,
    };
    if (hasFiles) {
      // رابط رفع لكل مصدر ملف — العميل يضيف &chunk=<k> لكل جزء 4MB
      resp.uploadChunkBytes = UPLOAD_CHUNK_BYTES;
      resp.uploads = sources.filter((s) => s.kind === 'file').map((s) => ({
        seq: s.seq,
        name: s.name,
        size: s.size,
        mime: s.mime,
        uploadUrl: `${origin}/api/upload?job=${id}&seq=${s.seq}`,
      }));
    }
    sendJson(res, 201, resp);
  } catch (e) {
    respondWithError(res, e);
  }
};
