# مولّد الوسائط MCP — خادم توليد صور وفيديو بالذكاء الاصطناعي مع تبديل تلقائي للمفاتيح

خادم MCP (Model Context Protocol) يمنح أي عميل مدعوم — ChatGPT (وضع المطور)، Claude Desktop، Cursor، وغيرها — أدوات توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة تحكم عربية لإدارة مفاتيح API ومتابعة المهام لحظيًا. الفكرة المحورية: **العميل لا يرى أخطاء المفاتيح أو الرصيد أبدًا**؛ فعند فشل مفتاح (رصيد منتهٍ، مفتاح باطل، تجاوز حد الطلبات) ينتقل الخادم تلقائيًا إلى المفتاح التالي بالترتيب الصارم ويكمل **نفس المهمة** بنفس `task_id` حتى النجاح.

## المزايا

- **تبديل تسلسلي صارم للمفاتيح**: المفاتيح تُجرَّب بترتيب إنشائها، والمفتاح الفاشل يُعلَّم `disabled` تلقائيًا مع تسجيل سبب الخطأ، والمهمة تكمل على المفتاح التالي دون أن يشعر العميل.
- **خمسة أدوات MCP**: `generate_image` و`generate_video` و`merge_videos` و`get_task` و`list_media` — كلها بواجهة عربية في نتائجها.
- **تسجيل دائم في Turso**: كل مهمة ومحاولة ونتيجة تُخزَّن في قاعدة بيانات LibSQL، و`list_media` يسترجع أي وسائط سابقة لاحقًا.
- **خدمة دمج فيديو مستقلة**: تنزيل حتى 10 مقاطع (أو قبول رفع مباشر)، ترميز موحّد بـ ffmpeg، وتخزين الناتج على شكل مقاطع 4MB في Turso مع بث يدعم نطاقات Range (تشغيل/تنزيل جزئي).
- **لوحة تحكم عربية RTL**: مدير مفاتيح (إضافة/تعطيل/حذف مع إخفاء كامل للمفتاح)، لوحة مهام تُحدَّث كل 5 ثوانٍ، وبطاقة ربط جاهزة القص واللصق لكل عميل.

## البنية

```
العميل (ChatGPT / Claude / Cursor)
   │  Streamable HTTP (SSE)
   ▼
خادم MCP على /mcp  ──►  منسّق التوليد (تبديل المفاتيح التسلسلي)
   │                        │
   │                        ▼
   │                 kie.ai / CometAPI (صور + فيديو)
   │
   ▼
خدمة الدمج merger-service (ffmpeg + Turso blobs)
```

- **المشروع الرئيسي**: Next.js 16 + TypeScript + Tailwind 4 — خادم MCP على `/mcp`، واجهات REST على `/api/keys` و`/api/tasks` و`/api/health`، ولوحة التحكم على `/`.
- **خدمة الدمج**: Node.js خالص (CommonJS) جاهزة لنشر Vercel داخل `merger-service/` — لا واجهات بناء، مع cron يومي لحذف النواتج الأقدم من 24 ساعة.

## الإعداد المحلي

```bash
# 1) الحزم
npm install
cd merger-service && npm install && cd ..

# 2) متغيرات البيئة
cp .env.example .env.local          # وعبّئ TURSO_DATABASE_URL و TURSO_AUTH_TOKEN و MERGER_API_BASE
cp merger-service/.env.example merger-service/.env

# 3) تهيئة قاعدة Turso (المخطط)
node scripts/db-setup.mjs schema

# 4) تشغيل الخدمتين (ترمينالان)
npm run dev                          # المشروع الرئيسي على 3000
cd merger-service && npm run dev     # خدمة الدمج على 3001
```

ثم افتح `http://localhost:3000` — أضف مفتاحك من لوحة التحكم أو مباشرة:

```bash
curl -X POST http://localhost:3000/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"provider":"kie","label":"مفتاحي","api_key":"مفتاحك-من-kie.ai"}'
```

## ربط العملاء بخادم MCP

العنوان: `http://localhost:3000/mcp` (بعد النشر: `https://your-app.vercel.app/mcp`)

<details>
<summary><b>ChatGPT (وضع المطور / الموصلات)</b></summary>

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable_http"
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop / Cursor وأي عميل MCP قياسي</b></summary>

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

ملاحظة: بعض العملاء يفضلون `mcp-remote` للمسارات المحلية:

```json
{
  "mcpServers": {
    "media-generator": { "command": "npx", "args": ["mcp-remote", "http://localhost:3000/mcp"] }
  }
}
```
</details>

إذا ضبطت `MCP_ACCESS_TOKEN` فأضف الترويسة `Authorization: Bearer <الرمز>` في إعدادات الخادم لدى العميل.

## الأدوات الخمس

| الأداة | المدخلات الأساسية | المخرجات |
| --- | --- | --- |
| `generate_image` | `prompt` (إلزامي)، `model`، `aspect_ratio`، `resolution`، `background`، `output_format`، `wait_seconds` | رابط مباشر للصورة، أو `task_id` للمتابعة |
| `generate_video` | `prompt`، `image_url` (صورة→فيديو)، `model`، `aspect_ratio`، `resolution`، `enable_audio`، `duration`، `wait_seconds` | `task_id` + نسبة التقدم |
| `merge_videos` | `urls` (روابط مباشرة) أو `task_ids` (مهام فيديو مكتملة) — من 2 إلى 10 | رابط فيديو مدموج على خدمة الدمج |
| `get_task` | `task_id` | الحالة والتقدم والرابط عند الاكتمال |
| `list_media` | `type`، `status`، `limit` | آخر الوسائط المخزَّنة في القاعدة |

سير العمل الموصى به للعميل (مضمَّن في تعليمات الخادم تلقائيًا): استدعِ `generate_image` أو `generate_video`؛ فإن عاد `task_id` فاستدعِ `get_task` كل ~10 ثوانٍ حتى الاكتمال. ولدمج عدة مقاطع نُفِّذت سابقًا، مرر `task_ids` إلى `merge_videos` بنفس الترتيب المطلوب.

## الأمان

- المفاتيح تُخزَّن في Turso ولا تُعاد كاملة عبر أي واجهة — فقط قناع مثل `18c11a5••••••••c903`.
- `/api/keys` و`/api/tasks` يجب حمايتهما بالنشر (ضبط `MCP_ACCESS_TOKEN` يحمي `/mcp`؛ أضف مصادقة للمسارات الإدارية أو قيّد الوصول عبر Vercel Authentication).
- ملفات `.env*` و`.secrets/` مستثناة من Git بالكامل — تحقق قبل أي رفع بأن المفتاح الحقيقي غير مضمَّن (`git log -p -- .secrets` يجب أن يرجع فارغًا).

## نشر Vercel

1. **المشروع الرئيسي**: اربط المستودع بـ Vercel، واضبط المتغيرات (`TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، `MERGER_API_BASE`، `MCP_ACCESS_TOKEN`)، ثم انشر — Next.js يُكتشف تلقائيًا.
2. **خدمة الدمج**: من مجلد `merger-service/` نفّذ `vercel --prod` (أو اربطه كمشروع ثانٍ بجذر `merger-service`). ملف `vercel.json` جاهز بحد `maxDuration: 300` و cron يومي على `/api/cron` للتنظيف.
3. حدّث `MERGER_API_BASE` في المشروع الرئيسي إلى رابط خدمة الدمج المنشورة.

> ملاحظة مهمة: ترميز ffmpeg يتجاوز حدود الدوال الخادمية المجانية أحيانًا للملفات الكبيرة؛ حد `maxDuration: 300` يغطي المقاطع القصيرة، وللملفات الثقيلة شغّل خدمة الدمج على خادم مستقل (الملفات مكتوبة لـ Node خالص فتعمل كما هي مع `node scripts/dev-server.js`).

## الاختبارات المنفَّذة فعليًا (نتائج حقيقية، ليست نظرية)

| الاختبار | النتيجة |
| --- | --- |
| توليد صورة حقيقية عبر MCP (`generate_image`) | ✅ رابط مباشر للصورة |
| توليد فيديو حقيقي (`generate_video` → `get_task` كل 10 ثوانٍ) | ✅ MP4 مكتمل خلال ~2.5 دقيقة |
| التبديل التسلسلي: مفتاح باطل أولًا ثم الصحيح | ✅ المهمة اكتملت بـ 2 محاولة، الباطل صار `disabled`، العميل رأى النجاح فقط |
| دمج مقطعين عبر روابط (`merge_videos`) | ✅ ملف 3.4MB مع بث Range صحيح (206 + Content-Range) |
| `list_media` و`/api/health` (فحص Turso + خدمة الدمج) | ✅ |
| اختبارات وحدة خدمة الدمج (ffmpeg، التقدم، التخزين، Range، التنظيف) | ✅ 11/11 |
| اختبارات HTTP لخدمة الدمج (رفع مجزأ 4MB، أخطاء 400/404/409/413/416/405، CORS، cron، حذف) | ✅ 24/24 |

## بنية المجلدات المهمة

```
src/app/mcp/route.ts          خادم MCP (Streamable HTTP + SSE)
src/app/api/                  keys / tasks / health
src/lib/                      المفاتيح، التصنيف، النماذج، المزودات، منسق التبديل، runMerge
src/app/page.tsx              لوحة التحكم العربية RTL
merger-service/               خدمة الدمج المستقلة (api/ + lib/ + scripts/)
scripts/db-setup.mjs          تهيئة Turso + أدوات مساعدة (schema / addkey / clear-tasks)
```
