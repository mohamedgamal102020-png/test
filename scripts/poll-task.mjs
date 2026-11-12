// متابعة مهمة عبر get_task كل ~10 ثوانٍ حتى اكتمالها أو فشلها
import { execSync } from "node:child_process";

const taskId = process.argv[2];
if (!taskId) {
  console.log("usage: node scripts/poll-task.mjs <task_id>");
  process.exit(1);
}

function callTool(name, args) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const out = execSync(
    `curl -sS -m 40 -N -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '${body}'`,
    { encoding: "utf8" }
  );
  for (const line of out.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        const j = JSON.parse(line.slice(5));
        if (j.result?.content?.[0]?.text !== undefined) return { text: j.result.content[0].text, isError: !!j.result.isError };
      } catch {
        /* سطر آخر */
      }
    }
  }
  return { text: "(لا رد)", isError: true };
}

const deadline = Date.now() + 12 * 60_000; // حتى 12 دقيقة
let iter = 0;
while (Date.now() < deadline) {
  iter++;
  const r = callTool("get_task", { task_id: taskId });
  const stamp = new Date().toISOString().slice(11, 19);
  const oneLine = r.text.replace(/\n+/g, " | ").slice(0, 220);
  console.log(`[${stamp}] #${iter} isError=${r.isError} ${oneLine}`);
  if (r.text.includes("✅") || r.text.includes("❌")) break;
  await new Promise((res) => setTimeout(res, 10_000));
}
