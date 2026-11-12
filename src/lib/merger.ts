// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
// القاعدة الحتمية: أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي؛ أخطاء شبكتنا = مؤقتة
import { ProviderError } from "./providers/types";

export function mergerBase(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}

export function mergerConfigured(): boolean {
  return mergerBase().length > 0;
}

export interface MergerJob {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

export async function mergerCreateJob(urls: string[]): Promise<MergerJob> {
  const base = mergerBase();
  if (!base) throw new ProviderError(undefined, "merger base URL not configured");
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j?.error || msg;
    } catch {
      /* نص خام */
    }
    throw new ProviderError(res.status, String(msg));
  }
  try {
    const j = JSON.parse(text);
    if (!j?.jobId) throw new ProviderError(res.status, "missing jobId in merger response");
    return j as MergerJob;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(res.status, "invalid JSON from merger createJob");
  }
}

export interface MergerProcessResult {
  status: "done" | "processing" | "failed";
  videoUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
}

/** تنفيذ الدمج (blocking ~10–15 ثانية) — 202 يعني ما تزال قيد المعالجة */
export async function mergerProcess(jobId: string): Promise<MergerProcessResult> {
  const base = mergerBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}/process`, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* قد يكون فارغًا */
  }
  if (res.status === 202) return { status: "processing" };
  if (!res.ok) {
    // فشل حتمي فوري — لا إعادة محاولة (مثل: مصدر يرفض التحميل HTTP 403)
    throw new ProviderError(res.status, String(body?.error || text.slice(0, 200) || `HTTP ${res.status}`));
  }
  const videoUrl =
    (typeof body.videoUrl === "string" && body.videoUrl) ||
    (typeof body.downloadUrl === "string" && body.downloadUrl) ||
    `${base}/api/jobs/${jobId}/video`;
  return {
    status: "done",
    videoUrl,
    size: typeof body.size === "number" ? body.size : undefined,
    duration: typeof body.duration === "number" ? body.duration : undefined,
    resolution: typeof body.resolution === "string" ? body.resolution : undefined,
  };
}

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled|canceled)$/i;

export interface MergerStatus {
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number; // 0..100 دائمًا
  videoUrl?: string;
  error?: string;
}

/** تحليل دفاعي لحالة المهمة — الجسم قد يرد فيه error بدون حقل status → نعاملها failed فورًا */
export async function mergerStatus(jobId: string): Promise<MergerStatus> {
  const base = mergerBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (res.status === 404) {
    throw new ProviderError(404, "merge job not found (deleted or expired after 24h)");
  }
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j?.error || msg;
    } catch {
      /* نص خام */
    }
    throw new ProviderError(res.status, String(msg));
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ProviderError(res.status, "invalid JSON from merger status");
  }

  const rawError = typeof j.error === "string" && j.error ? j.error : undefined;
  let st = typeof j.status === "string" ? j.status.toLowerCase() : "";
  if (!st && rawError) st = "failed";
  if (!st) st = "processing";

  // progress قد يأتي كسرًا 0..1 → اضربه في 100
  let progress = 0;
  const p = Number(j.progress);
  if (Number.isFinite(p)) progress = p > 0 && p <= 1 ? Math.round(p * 100) : Math.max(0, Math.min(100, Math.round(p)));

  const videoUrl =
    (typeof j.videoUrl === "string" && j.videoUrl) ||
    (typeof j.downloadUrl === "string" && j.downloadUrl) ||
    `${base}/api/jobs/${jobId}/video`;

  if (DONE_RE.test(st)) return { status: "done", progress: 100, videoUrl };
  if (FAILED_RE.test(st)) return { status: "failed", progress, videoUrl, error: rawError || "merge failed" };
  if (st === "queued" || st === "uploading") return { status: st, progress, videoUrl };
  return { status: "processing", progress: progress || 5, videoUrl };
}

export async function mergerDelete(jobId: string): Promise<void> {
  try {
    await fetch(`${mergerBase()}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* التنظيف اختياري — نتجاهل الأخطاء */
  }
}

/** فحص جهوزية خدمة الدمج — GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}
