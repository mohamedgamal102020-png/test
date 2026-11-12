/**
 * حماية الواجهات الإدارية (لوحة التحكم) — تُفعَّل تلقائيًا عند ضبط MCP_ACCESS_TOKEN.
 * العميل يرسل الترويسة x-admin-token بنفس القيمة؛ /api/health تبقى مفتوحة (بلا أسرار).
 * عند عدم الضبط (تطوير محلي) الواجهات مفتوحة كما هي.
 */
export function checkAdminToken(webReq: Request): Response | null {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return null; // غير مضبوط → لا حماية إضافية
  const provided = (webReq.headers.get("x-admin-token") || "").trim();
  if (provided && provided === expected) return null;
  return Response.json(
    { error: "غير مصرح — أرسل الترويسة x-admin-token بنفس قيمة رمز الحماية المضبوط على الخادم" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
