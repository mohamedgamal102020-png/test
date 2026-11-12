// سكربت تهيئة قاعدة Turso: إنشاء المخطط + إدخال مفتاح kie.ai الحقيقي
// لا يُطبع أي سر — المفاتيح تُخفى دائمًا
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

// قراءة المتغيرات من .env.local يدويًا
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
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
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider, created_at)`,
];

async function main() {
  const mode = process.argv[2] || "schema";

  if (mode === "schema" || mode === "all") {
    for (const sql of SCHEMA) await db.execute(sql);
    console.log("✓ schema ready");
    const rs = await db.execute("SELECT 1 AS ok");
    console.log("✓ db healthy:", JSON.stringify(rs.rows[0]));
  }

  if (mode === "addkey" || mode === "all") {
    // إدخال مفتاح kie.ai الحقيقي إذا لم يكن موجودًا
    const kieKey = readFileSync(new URL("../.secrets/kie.key", import.meta.url), "utf8").trim();
    const dup = await db.execute({
      sql: "SELECT id FROM api_keys WHERE provider='kie' AND api_key=?",
      args: [kieKey],
    });
    if (dup.rows.length > 0) {
      console.log("- kie key already present:", dup.rows[0].id);
    } else {
      const id = crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, 'kie', ?, ?, 'active')`,
        args: [id, "kie.ai — main", kieKey],
      });
      console.log("✓ inserted kie key:", id);
    }
  }

  if (mode === "add-bogus-key") {
    // مفتاح خاطئ لاختبار التبديل التسلسلي — يُدرج بتاريخ أقدم ليكون أول من يُجرَّب
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at) VALUES (?, 'kie', ?, ?, 'active', datetime('now', '-2 hours'))`,
      args: [id, "BOGUS — failover test", "sk-bogus-invalid-key-000000000000000"],
    });
    console.log("✓ inserted bogus key:", id);
  }

  if (mode === "clear-tasks") {
    // تنظيف آثار الاختبار: حذف كل صفوف المهام (المفاتيح تبقى كما هي)
    await db.execute("DELETE FROM tasks");
    console.log("✓ cleared tasks rows");
  }

  // عرض ملخص مفاتيح مقنّع فقط (بدون أي سر)
  const keys = await db.execute("SELECT id, provider, label, status, created_at FROM api_keys ORDER BY created_at ASC, id ASC");
  for (const k of keys.rows) console.log(`  key ${k.provider} ${k.id} [${k.status}] "${k.label}" @ ${k.created_at}`);
  const tasks = await db.execute("SELECT count(*) AS n FROM tasks");
  console.log("✓ tasks count:", tasks.rows[0].n);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
