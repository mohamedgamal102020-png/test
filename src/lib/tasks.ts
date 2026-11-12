// عمليات المهام على Turso — CRUD + سجل المحاولات + إحصائيات
import { getDb, ensureSchema } from "./turso";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type TaskType = "image" | "video" | "merge";

export interface Attempt {
  provider: string;
  keyId: string | null;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function parseAttempts(raw: string | null | undefined): Attempt[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseParams(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function parseUrls(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: TaskStatus;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      JSON.stringify(t.params ?? {}),
      t.status ?? "processing",
      t.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return (rs.rows[0] as unknown as TaskRow) ?? null;
}

/** تحديث جزئي + إلحاق محاولة اختياريًا + ضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: {
    status?: TaskStatus;
    progress?: number;
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    model?: string;
    result_urls?: string[] | null;
    error_message?: string | null;
    params?: Record<string, unknown>;
  },
  attempt?: Attempt
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: unknown[] = [];

  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    args.push(patch.model);
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls === null ? null : JSON.stringify(patch.result_urls));
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (patch.params !== undefined) {
    sets.push("params_json = ?");
    args.push(JSON.stringify(patch.params));
  }
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
  }

  // سجل المحاولات: قراءة ثم إلحاق (الحد 50 محاولة لتفادي تضخم الصف)
  if (attempt) {
    const cur = await getTask(id);
    const list = parseAttempts(cur?.attempts_json);
    list.push(attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(list.slice(-50)));
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args: args as never[] });
}

export async function listRecentTasks(
  limit = 10,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filter.type) {
    clauses.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(Math.max(1, Math.min(50, limit)));
  const rs = await getDb().execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: args as never[],
  });
  return rs.rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const rs = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = rs.rows[0] as unknown as Record<string, number | null>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}

/** حذف مهمة — يُستخدم في تنظيف آثار الاختبار */
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}
