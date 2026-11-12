// مدير المفاتيح — GET القائمة (مقنّعة دائمًا) + POST إضافة مع رفض التكرار
import { insertKey, listKeys } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";
import { checkAdminToken } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(webReq: Request): Promise<Response> {
  const denied = checkAdminToken(webReq);
  if (denied) return denied;
  await ensureSchema();
  const keys = await listKeys();
  return Response.json({ keys }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(webReq: Request): Promise<Response> {
  const denied = checkAdminToken(webReq);
  if (denied) return denied;
  await ensureSchema();
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await webReq.json();
  } catch {
    return Response.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }
  const provider = String(body.provider || "").toLowerCase();
  const apiKey = String(body.api_key || "").trim();
  const label = String(body.label || "").trim();

  if (provider !== "kie" && provider !== "cometapi") {
    return Response.json({ error: "المزود غير صالح — المسموح: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: "مفتاح API مطلوب" }, { status: 400 });
  }

  const res = await insertKey(provider as "kie" | "cometapi", apiKey, label);
  if ("duplicate" in res) {
    return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }
  const keys = await listKeys();
  const added = keys.find((k) => k.id === res.id);
  return Response.json({ ok: true, key: added, keys }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
