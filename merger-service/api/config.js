'use strict';
/**
 * api/config.js — GET /api/config: الحدود العامة + version (تستخدمها الواجهة والعملاء للتحقق المسبق).
 */
const { limits, UPLOAD_CHUNK_BYTES, CHUNK_ROW_BYTES, VERSION } = require('../lib/env');
const { sendJson, sendError, handleOptions } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة الطلب غير مسموحة — استخدم GET');
  sendJson(res, 200, {
    version: VERSION,
    maxSources: limits.maxSources,
    sourceMaxMB: limits.sourceMaxMB,
    outputMaxMB: limits.outputMaxMB,
    maxTotalDurationSec: limits.maxTotalDurationSec,
    uploadChunkBytes: UPLOAD_CHUNK_BYTES,
    chunkRowBytes: CHUNK_ROW_BYTES,
    outputTtlHours: 24,
    ffmpegPreset: limits.ffmpegPreset,
  });
};
