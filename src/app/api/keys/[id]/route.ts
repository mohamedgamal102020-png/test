// عمليات المفتاح الواحد — PATCH تعطيل/تنشيط يدوي + DELETE حذف
import { deleteKey, getKey, setKeyStatus, toMasked } from "@/lib/keys";
import { checkAdminToken } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(webReq: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = checkAdminToken(webReq);
  if (denied) return denied;
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = await webReq.json();
  } catch {
    return Response.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }
  const status = String(body.status || "");
  if (status !== "active" && status !== "disabled") {
    return Response.json({ error: "الحالة المسموحة يدويًا: active أو disabled" }, { status: 400 });
  }
  const ok = await setKeyStatus(id, status);
  if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  const k = await getKey(id);
  return Response.json({ ok: true, key: k ? toMasked(k) : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(webReq: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = checkAdminToken(webReq);
  if (denied) return denied;
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
