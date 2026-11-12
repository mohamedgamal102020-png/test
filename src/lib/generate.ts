// منسّق التوليد — قلب سياسة «لا توقف أبدًا» (قسم 4.3 و 6 من المواصفة)
// المبادئ:
//   1) الترتيب التسلسلي الصارم: أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — لا round-robin
//   2) عند أي خطأ مفتاح/رصيد: تبديل فوري للمفتاح التالي واستئناف نفس المهمة بنفس task_id
//   3) العميل لا يرى أخطاء المفاتيح أو الرصيد أبدًا — التبديل صامت من وجهة نظره
//   4) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing وتُعاد مع كل get_task (تهدئة ~45 ثانية)
import { randomUUID } from "node:crypto";
import { resolveModel, type ModelDef } from "./models";
import { getKeyPool, bumpKeyStats, markKeyByClass, getKey, type KeyRow } from "./keys";
import { getAdapter } from "./providers";
import { ProviderError } from "./providers/types";
import { classifyProviderError, isKeyOrBalanceMessage } from "./classify";
import { insertTask, getTask, updateTask, parseParams, type TaskRow, type Attempt, type TaskStatus } from "./tasks";

/** سقف نافذة الانتظار الفعلي — أقل من حد Vercel (60 ثانية) حتى لا تُقتل الدالة؛ العميل يتابع بـ get_task */
function maxWaitSeconds(): number {
  const v = Number(process.env.MAX_WAIT_SECONDS || 50);
  return Math.max(10, Math.min(240, Number.isFinite(v) ? v : 50));
}

const POLL_INTERVAL_MS = 3_000;
const CREATE_COOLDOWN_MS = 45_000;

export interface GenerationRequest {
  type: "image" | "video";
  modelInput?: string;
  prompt: string;
  /** معطيات المزود الأصلية كاملة — تُخزن في params_json لإعادة الإنشاء عند التبديل */
  input: Record<string, unknown>;
  waitSeconds?: number;
  /** بث تقدم حي خلال نافذة الانتظار (progress notifications) */
  onProgress?: (progress: number, message: string) => Promise<void> | void;
}

export interface GenerationOutcome {
  task: TaskRow;
  noKeys?: boolean; // لا مفاتيح نشطة لهذه الموديلات إطلاقًا
  badModel?: boolean; // اسم موديل غير معروف
}

interface CreationResult {
  created: boolean;
  syncCompleted?: boolean;
  fatalParams?: boolean;
  usedKeyId?: string;
}

function shortErr(msg: string): string {
  return String(msg || "").slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** تسجيل محاولة + تحديث عدّادات المفتاح + الوسم التلقائي حسب الفئة */
async function recordFailure(candidate: KeyRow, cls: string, message: string): Promise<void> {
  bumpKeyStats(candidate.id, false, shortErr(message)).catch(() => {});
  if (cls === "disabled") markKeyByClass(candidate.id, "disabled").catch(() => {});
  if (cls === "exhausted") markKeyByClass(candidate.id, "exhausted").catch(() => {});
}

/** تجربة المرشحين بالترتيب بدءًا من startIndex حتى أول نجاح في الإنشاء */
async function attemptCreation(
  taskId: string,
  model: ModelDef,
  input: Record<string, unknown>,
  pool: KeyRow[],
  startIndex: number,
  taskType: "image" | "video"
): Promise<CreationResult> {
  for (let i = startIndex; i < pool.length; i++) {
    const candidate = pool[i];
    const providerModel = model.providerModel[candidate.provider];
    if (!providerModel) continue; // هذا المزود لا يخدم الموديل
    const adapter = getAdapter(candidate.provider);

    try {
      // صور متزامنة (CometAPI تعيد الرابط فورًا)
      if (taskType === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(candidate.api_key, { ...input, __providerModel: providerModel });
        await updateTask(
          taskId,
          { status: "completed", progress: 100, provider: candidate.provider, key_id: candidate.id, result_urls: urls },
          { provider: candidate.provider, keyId: candidate.id, keyLabel: candidate.label, ok: true, at: new Date().toISOString() }
        );
        bumpKeyStats(candidate.id, true, null).catch(() => {});
        return { created: true, syncCompleted: true, usedKeyId: candidate.id };
      }

      // مهمة غير متزامنة عادية
      const { providerTaskId } = await adapter.createTask(candidate.api_key, providerModel, input);
      await updateTask(
        taskId,
        { provider: candidate.provider, provider_task_id: providerTaskId, key_id: candidate.id },
        { provider: candidate.provider, keyId: candidate.id, keyLabel: candidate.label, ok: true, at: new Date().toISOString() }
      );
      bumpKeyStats(candidate.id, true, null).catch(() => {});
      return { created: true, usedKeyId: candidate.id };
    } catch (e) {
      const cls = e instanceof ProviderError ? (e.cls ?? classifyProviderError(e.status, e.message)) : "temporary";
      const msg = e instanceof Error ? e.message : String(e);
      await updateTask(taskId, {}, {
        provider: candidate.provider,
        keyId: candidate.id,
        keyLabel: candidate.label,
        ok: false,
        errorClass: cls,
        error: shortErr(msg),
        at: new Date().toISOString(),
      });
      await recordFailure(candidate, cls, msg);
      // خطأ معطيات = توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: `معطيات الطلب مرفوضة من المزود: ${shortErr(msg)}` });
        return { created: false, fatalParams: true };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي الآن
      continue;
    }
  }
  return { created: false };
}

/** وضع «بانتظار توفر مفتاح صالح…» — المهمة تبقى processing */
async function setWaitingState(taskId: string): Promise<void> {
  const t = await getTask(taskId);
  const params = parseParams(t?.params_json);
  params.lastAllKeysFailedAt = new Date().toISOString();
  await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…", params });
}

/**
 * إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (بعد المفتاح الفاشل)
 * يعيد true إذا نجح الإنشاء (أو اكتملت المهمة فورًا لمزامنة الصور)
 */
async function recreateOnNextKey(taskId: string, task: TaskRow, failedKeyId: string | null): Promise<boolean> {
  const model = resolveModel(task.model);
  if (!model) {
    await updateTask(taskId, { status: "failed", error_message: "اسم موديل غير معروف — تعذّرت إعادة الإنشاء" });
    return false;
  }
  const params = parseParams(task.params_json);
  const input = (params.input as Record<string, unknown>) || {};
  const pool = await getKeyPool(model.providers);
  const idx = failedKeyId ? pool.findIndex((k) => k.id === failedKeyId) : -1;
  const start = idx >= 0 ? idx + 1 : 0;
  if (start >= pool.length) {
    await setWaitingState(taskId);
    return false;
  }
  const res = await attemptCreation(taskId, model, input, pool, start, task.type as "image" | "video");
  if (!res.created) {
    await setWaitingState(taskId);
    return false;
  }
  return true;
}

/** إعادة محاولة الإنشاء من بداية القائمة — مع تهدئة 45 ثانية بين المحاولات (تُستدعى من get_task) */
async function retryCreation(task: TaskRow): Promise<void> {
  const params = parseParams(task.params_json);
  const last = typeof params.lastAllKeysFailedAt === "string" ? Date.parse(params.lastAllKeysFailedAt) : 0;
  if (Date.now() - last < CREATE_COOLDOWN_MS) return; // داخل فترة التهدئة — انتظر
  const model = resolveModel(task.model);
  if (!model) return;
  const input = (params.input as Record<string, unknown>) || {};
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) return;
  const res = await attemptCreation(task.id, model, input, pool, 0, task.type as "image" | "video");
  if (!res.created) await setWaitingState(task.id);
}

/**
 * الاستقصاء الحي خلال نافذة الانتظار — مع تبديل صامت في منتصف المهمة
 * (فشل المزود برسالة مفتاح/رصيد → نفس المهمة تُعاد على المفتاح التالي)
 */
async function pollWindow(taskId: string, waitSeconds: number, onProgress?: GenerationRequest["onProgress"]): Promise<TaskRow> {
  const deadline = Date.now() + Math.min(waitSeconds, maxWaitSeconds()) * 1000;
  let lastProgress = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const task = await getTask(taskId);
    if (!task) break;
    if (task.status === "completed" || task.status === "failed") return task;
    if (!task.provider_task_id || !task.key_id) {
      // لم ينجح الإنشاء بعد — إذا انتهت التهدئة أعد المحاولة الآن
      const params = parseParams(task.params_json);
      const last = typeof params.lastAllKeysFailedAt === "string" ? Date.parse(params.lastAllKeysFailedAt) : 0;
      if (Date.now() - last >= CREATE_COOLDOWN_MS) {
        await retryCreationFromWindow(taskId);
      }
      continue;
    }

    const key = await getKey(task.key_id);
    if (!key || key.status === "disabled") {
      // المفتاح اختفى أو عُطّل أثناء المهمة → أعد الإنشاء على التالي
      const ok = await recreateOnNextKey(taskId, task, key ? key.id : null);
      if (!ok) return (await getTask(taskId)) ?? task;
      continue;
    }

    const model = resolveModel(task.model);
    if (!model) break;
    const adapter = getAdapter(task.provider || "kie");

    try {
      const r = await adapter.checkTask(key.api_key, task.provider_task_id);
      if (r.status === "completed") {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: r.urls ?? [] });
        return (await getTask(taskId)) ?? task;
      }
      if (r.status === "failed") {
        // فشل في منتصف المهمة: هل رسالته تطابق مشكلات مفتاح/رصيد؟
        if (isKeyOrBalanceMessage(r.error || "")) {
          await updateTask(taskId, {}, {
            provider: task.provider || "",
            keyId: key.id,
            keyLabel: key.label,
            ok: false,
            errorClass: "exhausted",
            error: shortErr(r.error || "mid-task key failure"),
            at: new Date().toISOString(),
          });
          await recordFailure(key, "exhausted", r.error || "mid-task key failure");
          const ok = await recreateOnNextKey(taskId, task, key.id);
          if (!ok) return (await getTask(taskId)) ?? task;
          continue;
        }
        // فشل حقيقي (انتهاك سياسة/معطيات) → failed نهائي
        await updateTask(taskId, { status: "failed", error_message: shortErr(r.error || "provider task failed") });
        return (await getTask(taskId)) ?? task;
      }
      // معالجة مستمرة — حدّث التقدم وابث إشعارًا
      const p = r.progress ?? Math.min(95, lastProgress + 5);
      lastProgress = p;
      await updateTask(taskId, { progress: p });
      if (onProgress) await onProgress(p, `قيد التوليد… ${p}%`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cls = e instanceof ProviderError ? (e.cls ?? classifyProviderError(e.status, e.message)) : "temporary";
      if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
        // مفتاح مرفوض/مستنزف أو الموديل غير مدعوم لدى هذا المزود → التالي
        await recordFailure(key, cls, msg);
        const ok = await recreateOnNextKey(taskId, task, key.id);
        if (!ok) return (await getTask(taskId)) ?? task;
        continue;
      }
      // temporary (429/5xx/شبكة) → ابقَ على نفس المفتاح واستمر بالاستقصاء
    }
  }
  return (await getTask(taskId)) as TaskRow;
}

/** إعادة محاولة إنشاء من داخل نافذة الاستقصاء (بدون فحص التهدئة المزدوج) */
async function retryCreationFromWindow(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const model = resolveModel(task.model);
  if (!model) return;
  const params = parseParams(task.params_json);
  const input = (params.input as Record<string, unknown>) || {};
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    await setWaitingState(taskId);
    return;
  }
  const res = await attemptCreation(taskId, model, input, pool, 0, task.type as "image" | "video");
  if (!res.created) await setWaitingState(taskId);
}

/** نقطة الدخول الرئيسية لتوليد الصور/الفيديو */
export async function runGeneration(req: GenerationRequest): Promise<GenerationOutcome> {
  const model = resolveModel(req.modelInput);
  if (!model) {
    // خطأ معطيات فوري — موديل غير معروف
    const id = randomUUID();
    await insertTask({
      id,
      model: String(req.modelInput || ""),
      type: req.type,
      prompt: req.prompt,
      status: "failed",
      params: { input: req.input },
    });
    await updateTask(id, { status: "failed", error_message: `unknown model: ${req.modelInput}` });
    const task = await getTask(id);
    return { task: task!, badModel: true };
  }

  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    // نرجع noKeys — الصياغة العربية تُبنى في طبقة الأدوات
    const id = randomUUID();
    await insertTask({
      id,
      model: model.canonical,
      type: req.type,
      prompt: req.prompt,
      status: "failed",
      params: { input: req.input },
    });
    await updateTask(id, { status: "failed", error_message: "لا توجد مفاتيح نشطة لهذا الموديل" });
    const task = await getTask(id);
    return { task: task!, noKeys: true };
  }

  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  const waitSeconds = typeof req.waitSeconds === "number" && req.waitSeconds >= 0 ? req.waitSeconds : req.type === "image" ? 90 : 25;
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: req.type,
    prompt: req.prompt,
    status: "processing",
    progress: 0,
    params: { input: req.input, waitSeconds, modelInput: req.modelInput ?? model.canonical },
  });

  const created = await attemptCreation(taskId, model, req.input, pool, 0, req.type);
  if (created.fatalParams) return { task: (await getTask(taskId))! };
  if (!created.created) {
    await setWaitingState(taskId);
    return { task: (await getTask(taskId))! };
  }
  if (created.syncCompleted) return { task: (await getTask(taskId))! };

  const task = await pollWindow(taskId, waitSeconds, req.onProgress);
  return { task };
}

/** تحديث المهمة حيًا من المزود عند get_task — بنفس منطق التبديل أعلاه */
export async function refreshGenerationTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  // لا provider_task_id بعد → إما انتظار مفتاح أو إعادة إنشاء بعد التهدئة
  if (!task.provider_task_id) {
    await retryCreation(task);
    return getTask(taskId);
  }

  const key = task.key_id ? await getKey(task.key_id) : null;
  if (!key || key.status === "disabled") {
    await recreateOnNextKey(taskId, task, key ? key.id : null);
    return getTask(taskId);
  }

  const model = resolveModel(task.model);
  if (!model) return task;
  const adapter = getAdapter(task.provider || "kie");

  try {
    const r = await adapter.checkTask(key.api_key, task.provider_task_id);
    if (r.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: r.urls ?? [] });
    } else if (r.status === "failed") {
      if (isKeyOrBalanceMessage(r.error || "")) {
        await recordFailure(key, "exhausted", r.error || "mid-task key failure");
        await recreateOnNextKey(taskId, task, key.id);
      } else {
        await updateTask(taskId, { status: "failed", error_message: shortErr(r.error || "provider task failed") });
      }
    } else {
      await updateTask(taskId, { progress: r.progress ?? task.progress });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cls = e instanceof ProviderError ? (e.cls ?? classifyProviderError(e.status, e.message)) : "temporary";
    if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
      await recordFailure(key, cls, msg);
      await recreateOnNextKey(taskId, task, key.id);
    }
    // temporary → أعد النتيجة كما هي، الاستدعاء التالي سيحاول مجددًا
  }
  return getTask(taskId);
}
