"use client";

// لوحة الإدارة العربية (RTL) — ثلاث بطاقات:
//   أ) مدير المفاتيح  ب) لوحة المهام (تحديث حي كل ~5 ثوانٍ)  ج) ربط السيرفر بأي عميل MCP
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  CheckCircle2,
  Copy,
  Database,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  Link2,
  LockKeyhole,
  ListVideo,
  Merge,
  Plug,
  RefreshCw,
  Trash2,
  Video,
  XCircle,
  Zap,
} from "lucide-react";

// ---------- أنواع ----------
interface MaskedKey {
  id: string;
  provider: string;
  label: string;
  status: string;
  masked_key: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  created_at: string;
}
interface TaskItem {
  id: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  prompt: string;
  provider: string | null;
  error_message: string | null;
  attempts: number;
  urls: string[];
  created_at: string;
}
interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  authRequired: boolean;
  merger: { base: string | null; healthy: boolean };
}

// ---------- أدوات صغيرة ----------
const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "منتظرة",
};
const TOOLS_INFO = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — يعيد الرابط جاهزًا أو task_id للمتابعة" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي — يعيد task_id يُتابَع بـ get_task" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (حتى 10 مقاطع)" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — توليد أو دمج — ويحدّثها حيًا من المزود" },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها — لاسترجاع نتائج سابقة" },
];

function relTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return `منذ ${Math.floor(diff)} ثانية`;
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
  return `منذ ${Math.floor(diff / 86400)} يوم`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "exhausted":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    case "completed":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "processing":
      return "bg-teal-500/15 text-teal-300 border-teal-500/40";
    case "pending":
      return "bg-teal-500/15 text-teal-300 border-teal-500/40";
    case "failed":
      return "bg-rose-500/15 text-rose-300 border-rose-500/40";
    default:
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
  }
}

// ---------- حماية الواجهات الإدارية ----------
// إذا ضُبط MCP_ACCESS_TOKEN على الخادم فتتطلب /api/keys و /api/tasks الترويسة x-admin-token
function useAdminToken() {
  const [token, setToken] = useState("");
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setToken(localStorage.getItem("mg.adminToken") || "");
      setReady(true);
    }, 0);
    // تزامن بين البطاقتين: إدخال الرمز في واحدة يفتح الأخرى فورًا
    const onExternal = () => setToken(localStorage.getItem("mg.adminToken") || "");
    window.addEventListener("mg-token-changed", onExternal);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mg-token-changed", onExternal);
    };
  }, []);

  const saveToken = useCallback((t: string) => {
    const v = t.trim();
    localStorage.setItem("mg.adminToken", v);
    setToken(v);
    setLocked(false);
    window.dispatchEvent(new Event("mg-token-changed"));
  }, []);

  return { token, locked, setLocked, ready, saveToken };
}

async function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-admin-token", token);
  return fetch(path, { ...init, headers, cache: "no-store" });
}

function TokenGate({ onSave }: { onSave: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
        <LockKeyhole className="h-4 w-4 shrink-0" />
        لوحة الإدارة محمية — أدخل رمز الحماية (نفس قيمة MCP_ACCESS_TOKEN المضبوطة على الخادم)
      </div>
      <div className="flex gap-2">
        <Input
          dir="ltr"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onSave(value)}
          placeholder="رمز الحماية"
          className="border-zinc-700 bg-zinc-950 text-left font-mono text-zinc-100 placeholder:text-zinc-500"
        />
        <Button
          onClick={() => value.trim() && onSave(value)}
          className="shrink-0 whitespace-nowrap bg-teal-600 text-white hover:bg-teal-500"
        >
          فتح اللوحة
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">
        يُحفظ الرمز في متصفحك فقط ويُرسل مع كل طلبات الإدارة. لضبطه على الخادم: أضف المتغير MCP_ACCESS_TOKEN في إعدادات Vercel ثم أعد النشر.
      </p>
    </div>
  );
}

// ---------- البطاقة: مدير المفاتيح ----------
function KeysCard() {
  const { toast } = useToast();
  const { token, locked, setLocked, saveToken } = useAdminToken();
  const [keys, setKeys] = useState<MaskedKey[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/keys", token);
      if (r.status === 401) {
        setLocked(true);
        return;
      }
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل أخطاء التحديث الدوري */
    }
  }, [token, setLocked]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل مفتاح API أولًا" });
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch("/api/keys", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      if (r.status === 401) {
        setLocked(true);
        return;
      }
      const j = await r.json();
      if (!r.ok) {
        toast({ title: j.error || "فشل إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ title: "تم إضافة المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة" });
        setApiKey("");
        setLabel("");
        setKeys(j.keys ?? []);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: MaskedKey) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    const r = await apiFetch(`/api/keys/${k.id}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (r.status === 401) {
      setLocked(true);
      return;
    }
    if (r.ok) {
      toast({ title: next === "disabled" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح" });
      load();
    }
  };

  const remove = async (k: MaskedKey) => {
    const r = await apiFetch(`/api/keys/${k.id}`, token, { method: "DELETE" });
    if (r.status === 401) {
      setLocked(true);
      return;
    }
    if (r.ok) {
      toast({ title: "تم حذف المفتاح" });
      load();
    }
  };

  if (locked) {
    return (
      <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <KeyRound className="h-5 w-5 text-teal-300" />
            مدير المفاتيح
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TokenGate onSave={saveToken} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <KeyRound className="h-5 w-5 text-teal-300" />
          مدير المفاتيح
        </CardTitle>
        <CardDescription className="leading-relaxed text-zinc-400">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو
          نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_auto]">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-950 border-zinc-700 text-zinc-100">
              <SelectItem value="kie">kie.ai</SelectItem>
              <SelectItem value="cometapi">CometAPI</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="تسمية اختيارية (مثال: المفتاح الأساسي)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
          />
          <Input
            placeholder="مفتاح API"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            dir="ltr"
            className="bg-zinc-950 border-zinc-700 text-zinc-100 font-mono text-left placeholder:text-zinc-500"
          />
        </div>
        <Button onClick={addKey} disabled={busy} className="w-full bg-teal-600 hover:bg-teal-500 text-white">
          <Zap className="h-4 w-4" />
          إضافة المفتاح
        </Button>

        <Separator className="bg-zinc-800" />

        {keys.length === 0 ? (
          <p className="text-sm text-zinc-500 py-6 text-center">لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.</p>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="space-y-2">
              {keys.map((k) => (
                <li key={k.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-zinc-600 text-zinc-300">
                        {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                      </Badge>
                      <code dir="ltr" className="font-mono text-xs text-zinc-300 bg-zinc-900 px-2 py-0.5 rounded">
                        {k.masked_key}
                      </code>
                      <Badge variant="outline" className={statusBadgeClass(k.status)}>
                        {k.status === "active" ? "نشط" : k.status === "exhausted" ? "مستنزف" : "معطّل"}
                      </Badge>
                      {k.label && <span className="text-xs text-zinc-400">{k.label}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggle(k)} title={k.status === "disabled" ? "تنشيط" : "تعطيل"}>
                        <EyeOff className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(k)} title="حذف" className="text-rose-300 hover:text-rose-200">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                    <span>استخدام: {k.usage_count}</span>
                    <span className="text-emerald-400">نجاح: {k.success_count}</span>
                    <span className="text-rose-400">فشل: {k.fail_count}</span>
                    <span>{relTime(k.created_at)}</span>
                  </div>
                  {k.last_error && (
                    <p dir="ltr" className="mt-1 truncate text-xs text-rose-300/80 font-mono text-left">
                      {k.last_error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- البطاقة: لوحة المهام ----------
function TasksCard() {
  const { token, locked, setLocked, saveToken } = useAdminToken();
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/tasks?limit=20", token);
      if (r.status === 401) {
        setLocked(true);
        return;
      }
      const j = await r.json();
      setStats(j.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
      setTasks(j.tasks ?? []);
      setInitialLoaded(true);
    } catch {
      /* تجاهل */
    }
  }, [token, setLocked]);

  useEffect(() => {
    const id = setTimeout(load, 0);
    const t = setInterval(load, 5_000);
    return () => {
      clearTimeout(id);
      clearInterval(t);
    };
  }, [load]);

  const statChips = [
    { label: "الإجمالي", value: stats.total, cls: "text-zinc-200", icon: Activity },
    { label: "مكتملة", value: stats.completed, cls: "text-emerald-300", icon: CheckCircle2 },
    { label: "فاشلة", value: stats.failed, cls: "text-rose-300", icon: XCircle },
    { label: "جارية", value: stats.processing, cls: "text-teal-300", icon: RefreshCw },
  ];

  const typeIcon = (t: string) =>
    t === "image" ? <ImageIcon className="h-4 w-4" /> : t === "video" ? <Video className="h-4 w-4" /> : <Merge className="h-4 w-4" />;

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <ListVideo className="h-5 w-5 text-teal-300" />
          لوحة المهام
          <span className="text-xs font-normal text-zinc-500">تتحدث تلقائيًا كل 5 ثوانٍ</span>
        </CardTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {statChips.map((s) => (
            <div key={s.label} className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
              <div className={`flex items-center gap-1.5 text-lg font-bold ${s.cls}`}>
                <s.icon className="h-4 w-4" />
                {s.value}
              </div>
              <div className="text-xs text-zinc-500">{s.label}</div>
            </div>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {locked ? (
          <TokenGate onSave={saveToken} />
        ) : !initialLoaded && tasks.length === 0 ? (
          <p className="text-sm text-zinc-500 py-6 text-center">جارٍ التحميل…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-zinc-500 py-6 text-center">
            لا توجد مهام بعد — اتصل بعميل MCP وجرّب generate_image أو generate_video.
          </p>
        ) : (
          <ScrollArea className="max-h-[28rem]">
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1 text-sm text-zinc-200">
                        {typeIcon(t.type)}
                        {TYPE_LABEL[t.type] ?? t.type}
                      </span>
                      <Badge variant="outline" className={statusBadgeClass(t.status)}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </Badge>
                      <code dir="ltr" className="font-mono text-[11px] text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded">
                        {t.model}
                      </code>
                      {t.attempts > 0 && <span className="text-[11px] text-zinc-500">محاولات: {t.attempts}</span>}
                    </div>
                    <span className="text-xs text-zinc-500">{relTime(t.created_at)}</span>
                  </div>
                  {t.prompt && <p className="mt-1.5 text-sm text-zinc-400 truncate">{t.prompt}</p>}
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="mt-2">
                      <Progress value={t.progress} className="h-1.5 bg-zinc-800 [&>div]:bg-teal-400" />
                      <span className="text-[11px] text-zinc-500">التقدم: {t.progress}%</span>
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="mt-1.5 text-xs text-rose-300/90">{t.error_message}</p>
                  )}
                  {t.status === "completed" && t.urls.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {t.urls.map((u) => (
                        <a
                          key={u}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-teal-600/50 bg-teal-500/10 px-2 py-1 text-xs text-teal-200 hover:bg-teal-500/20"
                        >
                          <Link2 className="h-3 w-3" />
                          فتح الرابط
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- البطاقة: ربط السيرفر ----------
function ConnectCard({ health }: { health: Health | null }) {
  const { toast } = useToast();
  const [origin, setOrigin] = useState("");
  const mcpUrl = origin ? `${origin}/mcp` : "";

  useEffect(() => {
    // قراءة origin بعد التركيب — مع تأجيل لتفادي setState المتزامن داخل التأثير
    const id = setTimeout(() => setOrigin(window.location.origin), 0);
    return () => clearTimeout(id);
  }, []);

  const authLine = health?.authRequired ? `,\n        "headers": { "Authorization": "Bearer ${"<MCP_ACCESS_TOKEN>"}" }` : "";

  const chatgptJson = `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl || "https://<your-app>.vercel.app/mcp"}"${authLine}
    }
  }
}`;
  const claudeJson = `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl || "https://<your-app>.vercel.app/mcp"}"${authLine}
    }
  }
}`;
  const cursorJson = `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl || "https://<your-app>.vercel.app/mcp"}"${authLine}
    }
  }
}`;

  const copyJson = async (json: string) => {
    const ok = await copyText(json);
    toast({ title: ok ? "تم نسخ الإعداد — الصقه في ملف إعدادات العميل" : "فشل النسخ — انسخ يدويًا", variant: ok ? "default" : "destructive" });
  };
  const copyUrl = async () => {
    const ok = await copyText(mcpUrl);
    toast({ title: ok ? "تم نسخ رابط MCP" : "فشل النسخ", variant: ok ? "default" : "destructive" });
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <Plug className="h-5 w-5 text-teal-300" />
          ربط السيرفر
        </CardTitle>
        <CardDescription>انقل الرابط والإعداد المناسب إلى أي عميل MCP — ChatGPT أو Claude أو Cursor وغيرها.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            dir="ltr"
            readOnly
            value={mcpUrl}
            className="bg-zinc-950 border-zinc-700 text-zinc-100 font-mono text-left"
          />
          <Button onClick={copyUrl} variant="outline" className="shrink-0 whitespace-nowrap border-zinc-600 text-zinc-200 hover:bg-zinc-800">
            <Copy className="h-4 w-4" />
            نسخ
          </Button>
        </div>

        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="bg-zinc-950 border border-zinc-800 grid grid-cols-3 w-full">
            <TabsTrigger value="chatgpt">ChatGPT / Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor وغيره</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="mt-3 space-y-2">
            <pre dir="ltr" className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 text-left">
              {chatgptJson}
            </pre>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => copyJson(chatgptJson)} className="border-zinc-600 text-zinc-200 hover:bg-zinc-800">
                <Copy className="h-3 w-3" /> نسخ JSON
              </Button>
              <p className="text-xs text-zinc-400 text-left">
                في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
              </p>
            </div>
          </TabsContent>
          <TabsContent value="claude" className="mt-3 space-y-2">
            <pre dir="ltr" className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 text-left">
              {claudeJson}
            </pre>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => copyJson(claudeJson)} className="border-zinc-600 text-zinc-200 hover:bg-zinc-800">
                <Copy className="h-3 w-3" /> نسخ JSON
              </Button>
              <p className="text-xs text-zinc-400 text-left">
                الصق في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.
              </p>
            </div>
          </TabsContent>
          <TabsContent value="cursor" className="mt-3 space-y-2">
            <pre dir="ltr" className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 text-left">
              {cursorJson}
            </pre>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => copyJson(cursorJson)} className="border-zinc-600 text-zinc-200 hover:bg-zinc-800">
                <Copy className="h-3 w-3" /> نسخ JSON
              </Button>
              <p className="text-xs text-zinc-400 text-left">
                نفس الصيغة تعمل مع Cursor و Windsurf و Cline (ملف mcp.json).
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <Separator className="bg-zinc-800" />

        <div>
          <h4 className="mb-2 text-sm font-semibold text-zinc-200">الأدوات المتاحة (5)</h4>
          <div className="flex flex-wrap gap-2">
            {TOOLS_INFO.map((t) => (
              <div key={t.name} className="group relative">
                <Badge variant="outline" className="border-teal-600/50 bg-teal-500/10 text-teal-200 font-mono cursor-default">
                  {t.name}
                </Badge>
                <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 hidden w-72 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs leading-relaxed text-zinc-300 shadow-xl group-hover:block">
                  {t.desc}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-relaxed text-amber-200">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
          المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
          العملية.
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- الصفحة ----------
export default function DashboardPage() {
  const [health, setHealth] = useState<Health | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    // الجلب الأول مع تأجيل لتفادي تحذير setState المتزامن داخل التأثير
    const id = setTimeout(loadHealth, 0);
    const t = setInterval(loadHealth, 15_000);
    return () => {
      clearTimeout(id);
      clearInterval(t);
    };
  }, [loadHealth]);

  const dbOk = health?.ok === true;
  const mergerOk = health?.merger?.healthy === true;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* الهيدر */}
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/15 border border-teal-500/40">
              <ImageIcon className="h-5 w-5 text-teal-300" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-zinc-400">خادم توليد الصور والفيديو ودمج المقاطع + تبديل مفاتيح تلقائي</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className={dbOk ? statusBadgeClass("completed") : statusBadgeClass("failed")}>
              <Database className="h-3 w-3" />
              {dbOk ? "Turso متصل" : "غير متصل"}
            </Badge>
            <Badge variant="outline" className={mergerOk ? statusBadgeClass("completed") : statusBadgeClass("exhausted")}>
              <Merge className="h-3 w-3" />
              {health ? (mergerOk ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مضبوطة") : "جارٍ الفحص…"}
            </Badge>
            <Badge variant="outline" className={statusBadgeClass("processing")}>
              <Video className="h-3 w-3" />
              gpt-image-2-6 · grok-imagine-video-1-5
            </Badge>
          </div>
        </div>
      </header>

      {/* البطاقات الثلاث */}
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
        <KeysCard />
        <TasksCard />
        <ConnectCard health={health} />
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto max-w-6xl px-4 py-3 text-center text-xs text-zinc-500">
          media-generator-mcp v1.2.0 — توليد عبر kie.ai و CometAPI · التبديل التسلسلي للمفاتيح يعمل دون توقف · ملفات
          الدمج تُحذف بعد 24 ساعة
        </div>
      </footer>
    </div>
  );
}
