// مزود kie.ai — Jobs API الموحّد (الأشكال أدناه مقاسة فعليًا بنداءات حقيقية، لا تخمين):
//   POST /api/v1/jobs/createTask   → {"code":200,"msg":"success","data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo   → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//                                     "resultJson":"{\"resultUrls\":[\"https://...\"]}",  ← نص JSON داخل JSON
//                                     "failMsg":"..."}}
import { ProviderError, type ProviderAdapter, type CheckTaskResult } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

/** توحيد رمي الأخطاء: يفضّل كود HTTP، وإلا كود JSON الداخلي، والرسالة من msg/failMsg/error */
async function throwKieError(res: Response, bodyText: string): Promise<never> {
  let status: number | undefined = res.status;
  let message = bodyText.slice(0, 300);
  try {
    const j = JSON.parse(bodyText);
    if (typeof j?.code === "number" && j.code !== 200) status = status === 200 ? j.code : status;
    message = j?.msg || j?.message || j?.error || j?.failMsg || bodyText.slice(0, 300);
  } catch {
    /* الرد ليس JSON — نستخدم النص كما هو */
  }
  throw new ProviderError(status, String(message));
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/createTask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: providerModel, input }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `network: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) await throwKieError(res, text);
    let j: { code?: number; msg?: string; data?: { taskId?: string } };
    try {
      j = JSON.parse(text);
    } catch {
      throw new ProviderError(res.status, "invalid JSON from kie.ai createTask");
    }
    if (j.code !== 200 || !j.data?.taskId) {
      throw new ProviderError(j.code ?? res.status, j.msg || "missing taskId in kie.ai response");
    }
    return { providerTaskId: j.data.taskId };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckTaskResult> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(undefined, `network: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) await throwKieError(res, text);
    let j: { code?: number; msg?: string; data?: { state?: string; resultJson?: string; failMsg?: string; failCode?: number } };
    try {
      j = JSON.parse(text);
    } catch {
      throw new ProviderError(res.status, "invalid JSON from kie.ai recordInfo");
    }
    if (j.code !== 200) throw new ProviderError(j.code ?? res.status, j.msg || "kie.ai recordInfo error");
    const d = j.data || {};
    const state = d.state || "waiting";

    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا (شكل حقيقي مقاس)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(d.resultJson || "{}");
        const list = parsed?.resultUrls;
        if (Array.isArray(list)) urls = list.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
      } catch {
        /* لا روابط قابلة للتحليل */
      }
      if (urls.length === 0) {
        return { status: "failed", error: "task succeeded but no result URLs found in provider response" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      const msg = d.failMsg || `provider task failed (code ${d.failCode ?? "?"})`;
      return { status: "failed", error: String(msg) };
    }

    // تقدّم تقديري حسب حالة kie (لا يوفر نسبة رقمية)
    const progress = state === "generating" ? 60 : state === "queuing" ? 25 : 10;
    return { status: "processing", progress };
  },
};
