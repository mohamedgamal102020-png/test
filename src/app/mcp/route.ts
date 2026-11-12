// مسار MCP — Streamable HTTP وفق مواصفة MCP عبر SDK الرسمي
// وضع stateless (sessionIdGenerator: undefined) للتوافق مع Vercel serverless:
//   كل طلب مستقل بلا جلسات — يعمل مع ChatGPT Connectors / Claude / Cursor / Cline
// runtime nodejs + force-dynamic إلزاميان (بث SSE حي)
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNodeReqRes } from "@/lib/mcp-http-adapter";
import { buildMcpServer } from "@/lib/mcp-server";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> */
function checkAuth(webReq: Request): Response | null {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return null;
  const auth = webReq.headers.get("authorization") || "";
  if (auth === `Bearer ${expected}`) return null;
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: valid Authorization: Bearer <token> required" }, id: null }),
    { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
}

function cors(base: Response): Response {
  base.headers.set("Access-Control-Allow-Origin", "*");
  base.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Accept");
  base.headers.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  return base;
}

export async function OPTIONS(): Promise<Response> {
  return cors(new Response(null, { status: 204 }));
}

/** DELETE لإنهاء الجلسة — في الوضع stateless لا توجد جلسات → 405 وفق المواصفة */
export async function DELETE(webReq: Request): Promise<Response> {
  const auth = checkAuth(webReq);
  if (auth) return auth;
  return cors(
    new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Method not allowed: stateless server keeps no sessions" }, id: null }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    )
  );
}

/** GET لتيار SSE مستقل — غير مدعوم في وضع stateless */
export async function GET(webReq: Request): Promise<Response> {
  const auth = checkAuth(webReq);
  if (auth) return auth;
  return cors(
    new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Method not allowed: stateless server provides no standalone SSE stream" }, id: null }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    )
  );
}

export async function POST(webReq: Request): Promise<Response> {
  const auth = checkAuth(webReq);
  if (auth) return auth;

  // تحليل جسم JSON-RPC (كائن واحد أو دفعة)
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await webReq.text());
  } catch {
    return cors(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" }, id: null }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  await ensureSchema();

  // transport/server لكل طلب — الوضع stateless الصحيح للـ serverless
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false, // بث SSE دائمًا حتى تصل إشعارات التقدم حيّة
  });
  const server = buildMcpServer();
  await server.connect(transport);

  const adapter = createNodeReqRes(webReq);
  // تشغيل المعالجة في الخلفية — نعيد Response فور جهوز الترويسة ليستمر البث حيًا
  const handlePromise = transport
    .handleRequest(adapter.req, adapter.res, parsedBody)
    .catch(() => {
      try {
        adapter.res.writeHead(500, { "Content-Type": "application/json" });
        adapter.res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } catch {
        /* الرد قد يكون بدأ بالفعل */
      }
    });
  const response = await adapter.response();
  void handlePromise; // يستمر حتى نهاية البث — لا ننتظره هنا
  return response;
}
