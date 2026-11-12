// GET /api/tasks — لوحة المهام: إحصائيات + أحدث المهام (تُحدَّث في الواجهة كل ~5 ثوانٍ)
import { listRecentTasks, taskStats, parseUrls, parseAttempts } from "@/lib/tasks";
import { checkAdminToken } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(webReq: Request): Promise<Response> {
  const denied = checkAdminToken(webReq);
  if (denied) return denied;
  const url = new URL(webReq.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, { type, status }),
  ]);

  const items = tasks.map((t) => ({
    id: t.id,
    type: t.type,
    model: t.model,
    status: t.status,
    progress: t.progress,
    prompt: t.prompt,
    provider: t.provider,
    error_message: t.error_message,
    attempts: parseAttempts(t.attempts_json).length,
    urls: t.status === "completed" ? parseUrls(t.result_urls_json) : [],
    created_at: t.created_at,
    completed_at: t.completed_at,
  }));

  return Response.json({ stats, tasks: items }, { headers: { "Cache-Control": "no-store" } });
}
