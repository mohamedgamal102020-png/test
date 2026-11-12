// تصنيف أخطاء المزودين — القلب الذي يقود سياسة تبديل المفاتيح
// (جدول 4.2 في المواصفة: disabled / exhausted / provider / params / temporary)

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** نمط رسائل فشل المفتاح/الرصيد — يُستخدم لكشف فشل منتصف المهمة (قسم 4.3.2) */
const KEY_OR_BALANCE_RE =
  /(insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值|402|401|unauthorized|invalid\s*api\s*key|forbidden)/i;

/** رسائل نفاد الرصيد تُفحص قبل قاعدة 400 لأن بعض المزودين يرسلونها بحالة 400 */
const EXHAUSTED_RE = /(insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值)/i;
const DISABLED_RE = /(invalid\s*api\s*key|unauthorized|forbidden|authentication)/i;
const MODEL_UNSUPPORTED_RE = /(model\s*not\s*found|unsupported\s*model|unknown\s*model|no\s*such\s*model)/i;

export function isKeyOrBalanceMessage(message: string): boolean {
  return KEY_OR_BALANCE_RE.test(message || "");
}

/**
 * تصنيف موحّد لأي خطأ قادم من مزود خارجي.
 * الترتيب مقصود: رسائل الرصيد أولًا، ثم 402، ثم تعطيل المفتاح، ثم الموديل، ثم المعطيات، ثم المؤقت.
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();

  // 1) نفاد الرصيد حسب الرسالة — بأي كود HTTP (حتى 400/500)
  if (EXHAUSTED_RE.test(m)) return "exhausted";
  // 2) 402 = Payment Required
  if (status === 402) return "exhausted";
  // 3) مفتاح مرفوض
  if (status === 401 || status === 403) return "disabled";
  if (DISABLED_RE.test(m)) return "disabled";
  // 4) الموديل غير مدعوم لدى هذا المزود
  if (MODEL_UNSUPPORTED_RE.test(m) && (status === 400 || status === 404 || status === 422 || status === undefined)) {
    return "provider";
  }
  // 5) معطيات الطلب تالفة — التبديل لن يحلها
  if (status === 400 || status === 422) return "params";
  // 6) 429 / 5xx / انقطاع شبكة / مهلة = مؤقت
  if (status === 429 || (status !== undefined && status >= 500)) return "temporary";
  // بلا كود HTTP (انقطاع شبكة، timeout، abort) = مؤقت
  return "temporary";
}
