'use strict';
/**
 * lib/http.js — أدوات HTTP مشتركة لنقاط Vercel Serverless:
 * CORS مفتوح على كل الاستجابات، أخطاء بصيغة {"error":"..."}، قراءة الجسم يدويًا (تعمل محليًا وعلى Vercel).
 */

// CORS مفتوح لكل المنشأ وفق المواصفة — يُطبَّق على كل الاستجابات بلا استثناء
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Range',
  'Access-Control-Expose-Headers': 'Content-Range,Accept-Ranges,Content-Length,Content-Disposition',
  'Access-Control-Max-Age': '86400',
};

function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

/** استجابة JSON موحّدة مع CORS */
function sendJson(res, statusCode, obj) {
  applyCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/** استجابة خطأ موحّدة بصيغة {"error":"..."} */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/** ردّ على طلبات الاستباق OPTIONS قبل أي معالجة أخرى */
function handleOptions(req, res) {
  applyCors(res);
  res.statusCode = 204;
  res.end();
}

/** استخراج الأصل (origin) الحقيقي من الترويسات — يعمل على Vercel ومحليًا */
function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * قراءة جسم الطلب يدويًا (يعمل مع Vercel Node functions والمحلي) —
 * مع حد أقصى: تجاوزه يعني رفضًا فوريًا 413، وما فوقه مضاعفًا يقطع الاتصال حفاظًا على الذاكرة.
 */
function readBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0; // لا نخزّن الزائد
        if (total > maxBytes * 8) {
          req.destroy(); // جسم ضخم بشكل غير طبيعي — قطع فوري
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error(`حجم الطلب يتجاوز الحد المسموح (${Math.floor(maxBytes / (1024 * 1024))}MB)`);
        err.statusCode = 413;
        reject(err);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => reject(e));
    req.on('close', () => { if (tooLarge) { /* النهاية ستُرسل من end */ } });
  });
}

/** قراءة جسم JSON مع رفض الصيغ التالفة برمز 400 ورسالة عربية */
async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  const raw = await readBody(req, { maxBytes });
  if (!raw.length) {
    throw jsonError(400, 'جسم الطلب فارغ — أرسل JSON صالحًا');
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw jsonError(400, 'صيغة JSON غير صالحة في جسم الطلب');
  }
}

/** خطأ JSON جاهز للرمي مع كود HTTP */
function jsonError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isBiz = true;
  return err;
}

/** تحويل أي خطأ مرمى إلى استجابة مناسبة */
function respondWithError(res, err) {
  const code = err && err.statusCode ? err.statusCode : 500;
  const message = err && err.message ? err.message : 'خطأ داخلي في الخادم';
  if (code >= 500) console.error('[merger-service] internal error:', err);
  sendError(res, code, message);
}

module.exports = {
  applyCors,
  sendJson,
  sendError,
  handleOptions,
  getOrigin,
  readBody,
  readJsonBody,
  jsonError,
  respondWithError,
};
