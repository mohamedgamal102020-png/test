// صياغة الردود العربية للأدوات — النموذج يقرأها ويعرضها للمستخدم كما هي
// لا تُذكر أخطاء المفاتيح أو الرصيد أبدًا في أي نص يخرج للعميل
import type { TaskRow } from "./tasks";
import { parseAttempts, parseUrls } from "./tasks";

/** تنقية رسائل الفشل: أي ذكر لمفتاح/رصيد يُستبدل بنص عام — دفاع في العمق */
export function sanitizeClientError(msg: string): string {
  const raw = (msg || "").toString();
  if (/(insufficient|quota|balance|credit|exhausted|充值|401|402|unauthorized|invalid\s*api\s*key|forbidden|api\s*key)/i.test(raw)) {
    return "تعذّر إكمال المهمة لدى المزود — سيُعاد المحاولة تلقائيًا عند توفر الموارد، أو جرّب لاحقًا.";
  }
  return raw.slice(0, 500);
}

export function fmtNoKeys(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function fmtImageDone(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);
  const url = urls[0] ?? "";
  const lines = ["✅ تم توليد الصورة بنجاح", "", url ? `![image](${url})` : "", url ? `الرابط المباشر: ${url}` : ""];
  return lines.filter((l) => l !== "").join("\n");
}

export function fmtVideoDone(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);
  const list = urls.map((u) => `- ${u}`).join("\n");
  return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${list || "—"}`;
}

export function fmtMergeDone(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);
  const list = urls.map((u) => `- ${u}`).join("\n");
  return (
    `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر:\n${list || "—"}\n\n` +
    `⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`
  );
}

export function fmtProcessing(task: TaskRow, kindHint?: "image" | "video" | "merge"): string {
  const p = task.progress ?? 0;
  const pct = p > 0 ? `\n\nالتقدم الحالي: ${p}%` : "";
  return (
    `⏳ المهمة قيد المعالجة — task_id: ${task.id}` +
    `${kindHint ? ` (${kindHint === "image" ? "توليد صورة" : kindHint === "video" ? "توليد فيديو" : "دمج مقاطع"})` : ""}` +
    `\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` +
    pct
  );
}

export function fmtFailed(reason: string): string {
  return `❌ فشلت المهمة: ${sanitizeClientError(reason)}`;
}

export function fmtMergeTooFew(): string {
  return "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
}

export function fmtMergeTooMany(): string {
  return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
}

export function fmtMergeBadUrls(bad: Array<{ index: number; url: string; reason: string }>): string {
  const lines = bad.map((b) => `- المقطع ${b.index + 1}: ${b.reason} (${b.url.slice(0, 80)})`).join("\n");
  return `❌ بعض الروابط غير صالحة للدمج — يجب أن تكون روابط http/https مباشرة وعامة:\n${lines}`;
}

export function fmtMergeResolveErrors(errors: Array<{ id: string; reason: string }>): string {
  const lines = errors.map((e) => `- ${e.id}: ${e.reason}`).join("\n");
  return `❌ تعذّر حل معرّفات المهام التالية:\n${lines}`;
}

export function fmtTaskNotFound(id: string): string {
  return `❌ لا توجد مهمة بهذا المعرّف: ${id}\n\nتحقق من المعرّف أو استخدم list_media لاسترجاع أحدث المهام.`;
}

export function fmtUnknownTool(name: string, available: string[]): string {
  return `❌ أداة غير معروفة: ${name}. المتاح: ${available.join(", ")}`;
}

export function fmtListMedia(tasks: TaskRow[]): string {
  if (tasks.length === 0) return "لا توجد مهام مخزنة حتى الآن — جرّب generate_image أو generate_video أولًا.";
  const typeLabel: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
  const statusLabel: Record<string, string> = { completed: "مكتملة ✅", failed: "فاشلة ❌", processing: "جارية ⏳", pending: "منتظرة ⏳" };
  const lines = tasks.map((t, i) => {
    const urls = parseUrls(t.result_urls_json);
    const prompt = (t.prompt || "").slice(0, 60);
    const base = `${i + 1}. [${statusLabel[t.status] ?? t.status}] ${typeLabel[t.type] ?? t.type} — ${t.model}${prompt ? ` — «${prompt}»` : ""}`;
    const links = t.status === "completed" && urls.length ? `\n   الروابط:\n${urls.map((u) => `   - ${u}`).join("\n")}` : "";
    const err = t.status === "failed" && t.error_message ? `\n   السبب: ${sanitizeClientError(t.error_message)}` : "";
    const tid = `\n   task_id: ${t.id}`;
    return `${base}${tid}${links}${err}`;
  });
  return `أحدث المهام المخزنة (من الأحدث):\n\n${lines.join("\n\n")}`;
}

export function attemptsSummary(task: TaskRow): string {
  const n = parseAttempts(task.attempts_json).length;
  return n > 0 ? `\n\n(محاولات داخلية: ${n})` : "";
}
