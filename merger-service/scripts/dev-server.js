'use strict';
/**
 * scripts/dev-server.js — خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحمّل api/*.js كموديولات CommonJS ويستدعي module.exports = async (req, res) => {}.
 * - يحلّل المسارات الديناميكية (/api/jobs/123/process → req.query.id = "123").
 * - يخدم ملفات public/ الثابتة (الواجهة).
 * - لا يحلّل أجسام الطلب هنا؛ كل معالج يقرأ جسمه بنفسه تمامًا كبيئة Vercel.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadEnv, PROJECT_ROOT } = require('../lib/env');
loadEnv(); // تحميل .env من جذر المشروع إن لم تكن المتغيرات موجودة

const PORT = Number(process.env.PORT || 3001); // البورت الافتراضي 3001 داخل الساندبوكس

// خريطة المسارات الثابتة → موديولات API
const STATIC_API = {
  '/api/jobs': require('../api/jobs.js'),
  '/api/upload': require('../api/upload.js'),
  '/api/config': require('../api/config.js'),
  '/api/cron': require('../api/cron.js'),
};

// المسارات الديناميكية: /api/jobs/<id>[/process|/video]
const DYNAMIC_API = [
  { re: /^\/api\/jobs\/([^/]+)\/process$/, mod: require('../api/jobs/[id]/process.js'), key: 'id' },
  { re: /^\/api\/jobs\/([^/]+)\/video$/, mod: require('../api/jobs/[id]/video.js'), key: 'id' },
  { re: /^\/api\/jobs\/([^/]+)$/, mod: require('../api/jobs/[id].js'), key: 'id' },
];

// أنواع المحتوى للملفات الثابتة
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** خدمة ملف ثابت من public/ مع حماية من الخروج خارج المجلد */
function serveStatic(req, res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PROJECT_ROOT, 'public', safe === '/' || safe === '\\' ? 'index.html' : safe);
  if (!filePath.startsWith(path.join(PROJECT_ROOT, 'public'))) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'مسار غير مسموح' }));
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'المسار غير موجود' }));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    pathname = u.pathname;
    // req.query يضم معاملات السطر + التقاطات المسارات الديناميكية — نفس سلوك Vercel
    req.query = Object.fromEntries(u.searchParams);
  } catch {
    req.query = {};
  }

  try {
    if (STATIC_API[pathname]) {
      await STATIC_API[pathname](req, res);
      return;
    }
    for (const route of DYNAMIC_API) {
      const m = route.re.exec(pathname);
      if (m) {
        req.query[route.key] = decodeURIComponent(m[1]); // /api/jobs/123/process → req.query.id = "123"
        await route.mod(req, res);
        return;
      }
    }
    if (pathname === '/' || !pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'المسار غير موجود' }));
  } catch (e) {
    console.error('[dev-server] handler crashed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'خطأ داخلي في الخادم' }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] خدمة دمج الفيديوهات تعمل على http://localhost:${PORT}`);
});
