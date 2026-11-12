// اختبار فعلي لأشكال kie.ai Jobs API — بدون تخمين: نستدعي ونطبع الشكل الحقيقي
import { readFileSync } from "node:fs";

const KEY = readFileSync(new URL("../.secrets/kie.key", import.meta.url), "utf8").trim();
const BASE = "https://api.kie.ai/api/v1/jobs";
const MODEL = process.argv[2] || "gpt-image-2-6/flare-text-to-image";

const headers = {
  "Authorization": `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function createTask() {
  const body = {
    model: MODEL,
    input: {
      prompt: "A tiny red origami paper crane on a wooden desk, soft studio lighting, minimalist background, high detail",
      aspect_ratio: "1:1",
      resolution: "1K",
      output_format: "png",
    },
  };
  const res = await fetch(`${BASE}/createTask`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  console.log("createTask HTTP", res.status, "->", text.slice(0, 500));
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (res.status >= 400) return null;
  return data?.data?.taskId ?? null;
}

async function recordInfo(taskId) {
  const res = await fetch(`${BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { console.log("recordInfo raw:", text.slice(0, 300)); return null; }
  return data;
}

const taskId = await createTask();
if (!taskId) { console.log("NO taskId — check response shape above"); process.exit(1); }
console.log("taskId:", taskId);

// استقصاء حتى اكتمال أو مهلة 4 دقائق
const deadline = Date.now() + 240_000;
let final = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const rec = await recordInfo(taskId);
  const state = rec?.data?.state;
  console.log(new Date().toISOString().slice(11, 19), "state:", state, Object.keys(rec?.data || {}).join(","));
  if (state === "success" || state === "fail") { final = rec; break; }
}

if (final) {
  const d = final.data || {};
  console.log("FINAL state:", d.state);
  console.log("failMsg:", d.failMsg ?? "(none)");
  if (typeof d.resultJson === "string") {
    try {
      const parsed = JSON.parse(d.resultJson);
      console.log("resultJson parsed keys:", Object.keys(parsed));
      console.log("resultUrls:", JSON.stringify(parsed.resultUrls ?? parsed, null, 2).slice(0, 600));
    } catch (e) {
      console.log("resultJson parse failed:", e.message, String(d.resultJson).slice(0, 300));
    }
  } else {
    console.log("resultJson (raw):", JSON.stringify(d.resultJson ?? d.result ?? d, null, 2).slice(0, 800));
  }
} else {
  console.log("POLL_TIMEOUT — task still running at provider");
}
