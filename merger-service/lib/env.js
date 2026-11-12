'use strict';
/**
 * lib/env.js — تحميل متغيرات البيئة من ملف .env يدويًا إن لم تكن موجودة في process.env،
 * وتوفير دوال قراءة الحدود العامة ديناميكيًا (حتى تعمل تعديلات البيئة فورًا في الاختبارات).
 */
const fs = require('fs');
const path = require('path');

// جذر المشروع = المجلد الأب لمجلد lib (مستقل عن process.cwd)
const PROJECT_ROOT = path.resolve(__dirname, '..');

let loaded = false;

/** يقرأ .env من جذر المشروع ويعبّئ process.env دون إعادة تعيين المتغيرات الموجودة */
function loadEnv() {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue; // تجاهل الأسطر الفارغة والتعليقات
    const key = m[1];
    let value = m[2].trim();
    // إزالة علامات الاقتباس المحيطة إن وجدت
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** قراءة رقم من البيئة مع قيمة افتراضية */
function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

module.exports = {
  loadEnv,
  PROJECT_ROOT,
  // دوال (لا قيم ثابتة) حتى تحترم أي تعديل لاحق للبيئة — قرار مهم لاختبار حدود الحجم
  limits: {
    get maxSources() { return Math.floor(num('MAX_SOURCES', 10)); },
    get sourceMaxBytes() { return Math.floor(num('SOURCE_MAX_MB', 200) * 1024 * 1024); },
    get sourceMaxMB() { return num('SOURCE_MAX_MB', 200); },
    get outputMaxBytes() { return Math.floor(num('OUTPUT_MAX_MB', 150) * 1024 * 1024); },
    get outputMaxMB() { return num('OUTPUT_MAX_MB', 150); },
    get maxTotalDurationSec() { return num('MAX_TOTAL_DURATION_SEC', 600); },
    get ffmpegPreset() { return (process.env.FFMPEG_PRESET || 'medium').trim(); },
  },
  // ثوابت التخزين: حد HTTP في Turso يقضي بتقسيم الـ Blob إلى صفوف 2MB
  CHUNK_ROW_BYTES: 2 * 1024 * 1024,
  READ_PAGE_ROWS: 8,
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // حجم جزء الرفع الثنائي من العميل
  OUTPUT_TTL_MS: 24 * 60 * 60 * 1000,  // صلاحية 24 ساعة
  VERSION: '1.0.0',
};
