// مزود CometAPI — وفق التوثيق الرسمي الحالي (apidoc.cometapi.com):
//   صور متزامنة: POST /v1/images/generations (متوافق مع OpenAI) → data[0].url فورًا
//   فيديو غير متزامن: POST /v1/videos (multipart/form-data) → {id} ثم GET /v1/videos/{id} → {status,...}
// ملاحظة: لا يوجد مفتاح CometAPI فعلي حاليًا — التنفيذ دفاعي ويتبع docs الرسمية فقط
import { ProviderError, type ProviderAdapter, type CheckTaskResult } from "./types";

const BASE = "https://api.cometapi.com";

async function throwCometError(res: Response, bodyText: string): Promise<never> {
  let message = bodyText.slice(0, 300);
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message || j?.message || j?.error || bodyText.slice(0, 300);
  } catch {
    /* غير JSON */
  }
  throw new ProviderError(res.status, String(message));
}

/** تحويل resolution إلى مقاس "WxH" للفيديو وفق نمط sora في docs */
function videoSize(input: Record<string, unknown>): string {
  const res = String(input.resolution || "480p");
  if (res === "1080p") return "1920x1080";
  if (res === "720p") return "1280x720";
  return "854x480";
}

export const cometapiAdapter: ProviderAdapter = {
  async createImageSync(apiKey, input) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: String(input.__providerModel || ""),
          prompt: String(input.prompt || ""),
          // OpenAI-compatible: نطلب رابطًا مستضيفًا لا b64 حتى نبقى «روابط فقط»
          response_format: "url",
          size: String(input.resolution === "4K" ? "2048x2048" : input.resolution === "2K" ? "1536x1536" : "1024x1024"),
          n: 1,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `network: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) await throwCometError(res, text);
    let j: { data?: Array<{ url?: string; b64_json?: string }> };
    try {
      j = JSON.parse(text);
    } catch {
      throw new ProviderError(res.status, "invalid JSON from cometapi images");
    }
    const url = j?.data?.[0]?.url;
    if (!url) throw new ProviderError(res.status, "no url in cometapi images response (b64_json not supported — links only)");
    return { urls: [url] };
  },

  async createTask(apiKey, providerModel, input) {
    // وفق docs: form-data مع model/prompt/seconds/size
    const form = new FormData();
    form.set("model", providerModel);
    form.set("prompt", String(input.prompt || ""));
    form.set("seconds", String(input.duration ?? 8));
    form.set("size", videoSize(input));
    if (typeof input.image_url === "string" && input.image_url) form.set("image_url", input.image_url);
    let res: Response;
    try {
      res = await fetch(`${BASE}/v1/videos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `network: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) await throwCometError(res, text);
    let j: { id?: string; task_id?: string };
    try {
      j = JSON.parse(text);
    } catch {
      throw new ProviderError(res.status, "invalid JSON from cometapi videos create");
    }
    const id = j.id || j.task_id;
    if (!id) throw new ProviderError(res.status, "missing id in cometapi videos response");
    return { providerTaskId: String(id) };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckTaskResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `network: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) await throwCometError(res, text);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text);
    } catch {
      throw new ProviderError(res.status, "invalid JSON from cometapi videos status");
    }
    const status = String(j.status ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "success") {
      // نجمع الرابط من أي حقل معروف، والبديل الأخير نقطة /content (رابط النتيجة لدى المزود)
      const direct =
        (typeof j.video_url === "string" && j.video_url) ||
        (typeof j.url === "string" && j.url) ||
        (Array.isArray(j.output) && typeof j.output[0] === "string" && (j.output[0] as string)) ||
        `${BASE}/v1/videos/${providerTaskId}/content`;
      return { status: "completed", urls: [direct], progress: 100 };
    }
    if (status === "failed" || status === "error") {
      const errObj = (j.error ?? {}) as { message?: string } | string | undefined;
      const errMsg = typeof errObj === "string" ? errObj : (errObj?.message ?? "cometapi task failed");
      return { status: "failed", error: String(errMsg) };
    }
    return { status: "processing", progress: 40 };
  },
};
