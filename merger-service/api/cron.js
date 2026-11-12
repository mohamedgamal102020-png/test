'use strict';
/**
 * api/cron.js — GET /api/cron: حذف المهام المنتهية الصلاحية وأجزائها (Cron يومي عبر vercel.json).
 */
const db = require('../lib/db');
const { sendJson, sendError, handleOptions, respondWithError } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم GET');
  try {
    await db.initSchema();
    const deleted = await db.cleanupExpired();
    sendJson(res, 200, { ok: true, deleted, ts: db.nowIso() });
  } catch (e) {
    respondWithError(res, e);
  }
};
