// سجل الموديلات — الأسماء الموحّدة + الصيغ البديلة + اسم الموديل لدى كل مزود
// الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL ... إلخ)
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2.6-flare-text-to-image", "gpt-image-2-6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOr("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envOr("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

/** توحيد اسم الموديل القادم من العميل — يقبل الصيغ بالنقاط ويطابق canonical أو aliases */
export function resolveModel(name: string | undefined): ModelDef | null {
  if (!name) return MODELS[0]; // الافتراضي: موديل الصور
  const n = name.trim().toLowerCase().replace(/\s+/g, "");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === n) return m;
    if (m.aliases.some((a) => a.toLowerCase() === n)) return m;
  }
  return null;
}

export const MERGE_MODEL = "video-merger"; // اسم ثابت لمهام الدمج في القاعدة
