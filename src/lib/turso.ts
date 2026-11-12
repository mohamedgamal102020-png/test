// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP، متوافقة مع Vercel serverless
// لا ملفات SQLite محلية إطلاقًا في الإنتاج
import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

/** عميل واحد مشترك — يُنشأ عند أول وصول */
export function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      // رسالة تشخيصية داخلية فقط — لا تُعرض للعميل عبر MCP
      throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN env vars");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول — بلا أداة migrations */
export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider, created_at)`);
    })().catch((e) => {
      // نسمح بإعادة المحاولة لاحقًا إذا فشل الإنشاء
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/** فحص جهوزية القاعدة */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
