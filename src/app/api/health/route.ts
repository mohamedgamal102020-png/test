// GET /api/health — جهوزية النظام: القاعدة + الموديلات + خدمة الدمج + حالة المصادقة
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  const databaseOk = await dbHealthy();
  const mergerHealthyOk = await mergerHealthy();

  return Response.json(
    {
      ok: databaseOk,
      database: databaseOk ? "turso-connected" : "turso-unreachable",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: mergerBase() || null, healthy: mergerHealthyOk },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
