// نظام المفاتيح — الترتيب التسلسلي الصارم حسب الإضافة + الإخفاء الإلزامي في كل الاستجابات
import { getDb, ensureSchema } from "./turso";
import { randomUUID } from "node:crypto";

export type KeyProvider = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface MaskedKey extends Omit<KeyRow, "api_key"> {
  masked_key: string;
  attempts: number; // عدد محاولات الحياة (usage_count)
}

/** إخفاء المفتاح: أول 7 + •••••••• + آخر 4 — والمفاتيح القصيرة: أول 3 + •••• */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

export function toMasked(k: KeyRow): MaskedKey {
  const { api_key, ...rest } = k;
  return { ...rest, masked_key: maskKey(api_key), attempts: Number(k.usage_count ?? 0) };
}

/**
 * جلب مرشّحي المفاتيح بهذا الترتيب بالضبط: أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC).
 * المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: readonly string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: [...providers] as never[],
  });
  return rs.rows as unknown as KeyRow[];
}

export async function insertKey(provider: KeyProvider, apiKey: string, label: string): Promise<{ id: string } | { duplicate: true }> {
  await ensureSchema();
  const dup = await getDb().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) return { duplicate: true };
  const id = randomUUID();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label || "", apiKey],
  });
  return { id };
}

export async function listKeys(): Promise<MaskedKey[]> {
  await ensureSchema();
  const rs = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return (rs.rows as unknown as KeyRow[]).map(toMasked);
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return (rs.rows[0] as unknown as KeyRow) ?? null;
}

/** تعطيل/تنشيط يدوي من الواجهة */
export async function setKeyStatus(id: string, status: KeyStatus): Promise<boolean> {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: "UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?",
    args: [status, id],
  });
  return rs.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}

/** وسم تلقائي حسب فئة الخطأ: disabled / exhausted (المستنزف يبقى في القاعدة) */
export async function markKeyByClass(id: string, cls: "disabled" | "exhausted"): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: "UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?",
    args: [cls, id],
  });
}

/** تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — دائمًا */
export async function bumpKeyStats(id: string, ok: boolean, errMsg: string | null): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, errMsg, id],
  });
}
