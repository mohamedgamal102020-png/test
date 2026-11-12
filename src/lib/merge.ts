// منسّق الدمج — runMerge + refreshMergeTask
// قواعد المواصفة (قسم 7.3):
//   ≥2 مقاطع و ≤10، روابط http/https مباشرة عامة فقط
//   تسجيل المهمة في Turso أولًا، ثم POST /api/jobs، ثم تنفيذ process مرة واحدة فقط (قفل + عَلَم في القاعدة)
//   أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة ويستمر الاستقصاء
//   ملفات الدمج تُحذف بعد 24 ساعة — التحذير يظهر في نص النتيجة وفي وصف الأداة
import { randomUUID } from "node:crypto";
import { insertTask, getTask, updateTask, parseParams, parseUrls, type TaskRow } from "./tasks";
import { MERGE_MODEL } from "./models";
import { mergerCreateJob, mergerProcess, mergerStatus, mergerConfigured, mergerBase } from "./merger";
import { ProviderError } from "./providers/types";
import { fmtMergeTooFew, fmtMergeTooMany, fmtMergeBadUrls, fmtMergeResolveErrors, sanitizeClientError } from "./format";

const POLL_INTERVAL_MS = 3_000;
const CREATE_COOLDOWN_MS = 45_000;

/** قفل في الذاكرة يمنع تزامن نداء process مع get_task */
const processInFlight = new Set<string>();

export interface MergeRequest {
  urls?: string[];
  taskIds?: string[];
  waitSeconds?: number;
  onProgress?: (progress: number, message: string) => Promise<void> | void;
}

export interface MergeOutcome {
  task?: TaskRow | null;
  errorText?: string; // رفض مبدئي (أقل من 2 / أكثر من 10 / روابط تالفة / خدمة غير مضبوطة)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shortErr(msg: string): string {
  return String(msg || "").slice(0, 300);
}

/** هل الرابط مباشر عام (http/https، بلا نطاقات داخلية) */
function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "0.0.0.0") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** حل روابط task_ids (مهام فيديو مكتملة) بالترتيب — ثم urls المباشرة بنفس ترتيبها */
async function resolveTaskUrls(taskIds: string[]): Promise<{ urls: string[]; errors: Array<{ id: string; reason: string }> }> {
  const urls: string[] = [];
  const errors: Array<{ id: string; reason: string }> = [];
  for (const id of taskIds) {
    const t = await getTask(id);
    if (!t) {
      errors.push({ id, reason: "لا توجد مهمة بهذا المعرّف" });
      continue;
    }
    if (t.type !== "video") {
      errors.push({ id, reason: `المهمة ليست مهمة فيديو (النوع: ${t.type})` });
      continue;
    }
    if (t.status !== "completed") {
      errors.push({ id, reason: `المهمة ليست مكتملة بعد (الحالة: ${t.status}) — أكملها بـ get_task أولًا` });
      continue;
    }
    const u = parseUrls(t.result_urls_json);
    if (u.length === 0) {
      errors.push({ id, reason: "لا توجد روابط نتائج مخزنة لهذه المهمة" });
      continue;
    }
    urls.push(u[0]); // مهمة الفيديو تعيد مقطعًا واحدًا
  }
  return { urls, errors };
}

/**
 * تنفيذ process مرة واحدة فقط لكل مهمة — حماية مزدوجة:
 * عَلَم process_started في القاعدة (يعمل عبر عمليات serverless) + قفل في الذاكرة (ضد التزامن المحلي)
 */
export function ensureMergeProcessStarted(taskId: string, jobId: string, params: Record<string, unknown>): void {
  if (params.process_started === true) return;
  params.process_started = true;
  void updateTask(taskId, { params });
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      const r = await mergerProcess(jobId);
      if (r.status === "done" && r.videoUrl) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [r.videoUrl] });
      } else if (r.status === "failed") {
        await updateTask(taskId, { status: "failed", error_message: shortErr(r.error || "merge failed") });
      }
      // processing → الاستقصاء عبر get_task يكمل التحديث
    } catch (e) {
      if (e instanceof ProviderError && e.status !== undefined) {
        // قاعدة حتمية: أي خطأ HTTP معلن من خدمة الدمج = فشل نهائي فوري — لا إعادة محاولة
        await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج رفضت العملية (HTTP ${e.status}): ${shortErr(e.message)}` });
      }
      // أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → الاستقصاء يستمر حتى انتهاء النافذة
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** إنشاء مهمة دمج جديدة (أو إعادة المحاولة من refreshMergeTask) */
async function createMergeJob(taskId: string, urls: string[]): Promise<string | null> {
  const job = await mergerCreateJob(urls); // قد يرمي ProviderError
  await updateTask(taskId, { provider_task_id: job.jobId }, {
    provider: "merger",
    keyId: null,
    ok: true,
    at: new Date().toISOString(),
  });
  return job.jobId;
}

/** التدفق الرئيسي للدمج */
export async function runMerge(req: MergeRequest): Promise<MergeOutcome> {
  // 1) التحقق الصارم قبل أي شيء — حل روابط task_ids مرة واحدة
  const { urls: taskUrls, errors: resolveErrors } = await resolveTaskUrls(req.taskIds ?? []);
  const directUrls = (req.urls ?? []).filter((u) => typeof u === "string" && u.trim());
  const combined = [...taskUrls, ...directUrls];

  if (combined.length < 2) {
    let text = fmtMergeTooFew();
    if (resolveErrors.length > 0) text += `\n\n${fmtMergeResolveErrors(resolveErrors)}`;
    return { errorText: text };
  }
  if (combined.length > 10) return { errorText: fmtMergeTooMany() };

  const bad = combined
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => !isPublicHttpUrl(u))
    .map(({ u, i }) => ({ index: i, url: u, reason: "ليس رابطًا مباشرًا عامًا" }));
  if (bad.length > 0) return { errorText: fmtMergeBadUrls(bad) };

  if (!mergerConfigured()) {
    return { errorText: "❌ خدمة الدمج غير مضبوطة — أضف MERGER_API_BASE إلى متغيرات البيئة ثم أعد المحاولة." };
  }

  // 2) تسجيل المهمة في Turso أولًا
  const taskId = randomUUID();
  const waitSeconds = typeof req.waitSeconds === "number" && req.waitSeconds >= 0 ? req.waitSeconds : 60;
  await insertTask({
    id: taskId,
    provider: "merger",
    model: MERGE_MODEL,
    type: "merge",
    prompt: `دمج ${combined.length} مقاطع`,
    status: "processing",
    progress: 0,
    params: { urls: combined, waitSeconds, process_started: false },
  });

  // 3) إنشاء مهمة لدى خدمة الدمج
  let jobId: string | null = null;
  try {
    jobId = await createMergeJob(taskId, combined);
  } catch (e) {
    if (e instanceof ProviderError && e.status !== undefined) {
      // خطأ معلن من الخدمة عند الإنشاء = فشل نهائي
      await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج رفضت إنشاء المهمة (HTTP ${e.status}): ${shortErr(e.message)}` });
      return { task: await getTask(taskId) };
    }
    // خطأ شبكة مؤقت — المهمة تبقى processing وتُعاد مع get_task بعد التهدئة
    const params = { urls: combined, waitSeconds, process_started: false, lastAllKeysFailedAt: new Date().toISOString() };
    await updateTask(taskId, { error_message: "بانتظار جهوزية خدمة الدمج…", params });
    return { task: await getTask(taskId) };
  }

  // 4) إطلاق process خلفيًا وبمرة واحدة فقط
  if (!jobId) return { task: await getTask(taskId) }; // حماية نظرية — createMergeJob يرمي بدل إرجاع null
  ensureMergeProcessStarted(taskId, jobId, { process_started: false });

  // 5) نافذة الانتظار: استقصاء كل 3 ثوانٍ مع بث تقدم — التحديث يُكتب في Turso فورًا كل مرة
  const deadline = Date.now() + Math.min(waitSeconds, 50) * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const t = await getTask(taskId);
    if (!t) break;
    if (t.status === "completed" || t.status === "failed") return { task: t };
    if (!t.provider_task_id) continue;
    try {
      const st = await mergerStatus(t.provider_task_id);
      if (st.status === "done") {
        const resultUrl = st.videoUrl || `${mergerBase()}/api/jobs/${t.provider_task_id}/video`;
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [resultUrl] });
        return { task: await getTask(taskId) };
      }
      if (st.status === "failed") {
        await updateTask(taskId, { status: "failed", error_message: shortErr(st.error || "merge failed") });
        return { task: await getTask(taskId) };
      }
      const p = Math.max(t.progress ?? 0, st.progress);
      await updateTask(taskId, { progress: p });
      if (req.onProgress) await req.onProgress(p, `قيد الدمج… ${p}%`);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        await updateTask(taskId, {
          status: "failed",
          error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        });
        return { task: await getTask(taskId) };
      }
      // خطأ شبكة مؤقت — استمر بالاستقصاء حتى انتهاء النافذة
    }
  }
  return { task: await getTask(taskId) };
}

/** تحديث مهمة الدمج حيًا من الخدمة عند get_task */
export async function refreshMergeTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  const params = parseParams(task.params_json);
  const urls = Array.isArray(params.urls) ? (params.urls as string[]) : parseUrls(task.result_urls_json);

  // لم تُنشأ المهمة لدى الخدمة بعد (فشل شبكة سابق) — أعد المحاولة بعد تهدئة 45 ثانية
  if (!task.provider_task_id) {
    const last = typeof params.lastAllKeysFailedAt === "string" ? Date.parse(params.lastAllKeysFailedAt) : 0;
    if (!mergerConfigured()) return task;
    if (Date.now() - last >= CREATE_COOLDOWN_MS && urls.length >= 2) {
      try {
        await createMergeJob(taskId, urls);
        const t2 = await getTask(taskId);
        if (t2?.provider_task_id) ensureMergeProcessStarted(taskId, t2.provider_task_id, parseParams(t2.params_json));
      } catch (e) {
        if (e instanceof ProviderError && e.status !== undefined) {
          await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج رفضت إنشاء المهمة (HTTP ${e.status}): ${shortErr(e.message)}` });
        } else {
          params.lastAllKeysFailedAt = new Date().toISOString();
          await updateTask(taskId, { params });
        }
      }
    }
    return getTask(taskId);
  }

  // إن كانت processing ولم يُنفَّذ process بعد → نفّذه الآن (القفل يمنع التزامن)
  ensureMergeProcessStarted(taskId, task.provider_task_id, params);

  try {
    const st = await mergerStatus(task.provider_task_id);
    if (st.status === "done") {
      const resultUrl = st.videoUrl || `${mergerBase()}/api/jobs/${task.provider_task_id}/video`;
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: [resultUrl] });
    } else if (st.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: shortErr(st.error || "merge failed") });
    } else {
      await updateTask(taskId, { progress: Math.max(task.progress ?? 0, st.progress) });
    }
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) {
      await updateTask(taskId, {
        status: "failed",
        error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      });
    }
    // أخطاء أخرى مؤقتة — أعد النتيجة كما هي
  }
  return getTask(taskId);
}

export { sanitizeClientError };
