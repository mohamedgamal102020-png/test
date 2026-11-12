// محوّل HTTP: يحوّل Web Request (Next.js App Router) إلى زوج Node req/res
// متوافق مع ما يتوقعه @hono/node-server داخل StreamableHTTPServerTransport الرسمي،
// ويعيد Response تيارًا (Streaming) حتى تصل إشعارات التقدم حيّة أثناء التوليد.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

interface MockResState {
  statusCode: number;
  headers: Record<string, string>;
  headersSent: boolean;
  ended: boolean;
  queue: Uint8Array[];
  waiters: Array<() => void>;
  emitter: EventEmitter;
}

function pushChunk(state: MockResState, chunk?: string | Uint8Array): void {
  if (chunk) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    state.queue.push(bytes);
  }
  const w = state.waiters;
  state.waiters = [];
  for (const fn of w) fn();
}

/**
 * يعيد زوج req/res زائفًا + دالة response() تنتظر writeHead ثم تبني Web Response
 * يبث محتوى res.write/end في الزمن الحقيقي (SSE يتدفق فورًا لا في النهاية).
 */
export function createNodeReqRes(webReq: Request): {
  req: IncomingMessage;
  res: ServerResponse;
  response: () => Promise<Response>;
} {
  // ---------- req ----------
  const url = new URL(webReq.url);
  const reqUrl = url.pathname + url.search;
  const headers: Record<string, string> = { host: url.host || "localhost" };
  webReq.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const reqStream = Readable.from([]); // الجسم مُحلَّل مسبقًا (parsedBody) — لا يُقرأ هذا التيار
  const req = reqStream as unknown as IncomingMessage;
  // rawHeaders مصفوفة مسطحة [key, value, ...] — يقرأها @hono/node-server داخليًا
  const rawHeaders: string[] = [];
  for (const [k, v] of Object.entries(headers)) rawHeaders.push(k, String(v));
  Object.assign(req, {
    method: webReq.method,
    url: reqUrl,
    headers,
    rawHeaders,
    socket: { encrypted: false },
    httpVersion: "1.1",
    destroy() {
      /* لا شيء لتنظيفه — التيار فارغ أصلًا */
    },
  });
  // قطع اتصال العميل → إشعار req بالانقطاع (الـ transport يجهّز abort signal للأدوات)
  webReq.signal?.addEventListener(
    "abort",
    () => {
      req.emit("close");
      reqStream.destroy();
    },
    { once: true }
  );

  // ---------- res ----------
  const state: MockResState = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    ended: false,
    queue: [],
    waiters: [],
    emitter: new EventEmitter(),
  };

  const resObj = {
    get headersSent() {
      return state.headersSent;
    },
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    get writable() {
      return !state.ended;
    },
    get writableFinished() {
      return state.ended;
    },
    _contentLength: null as number | null,
    _hasBody: true,
    useChunkedEncodingByDefault: true,
    _removedContLen: false,
    writeHead(status: number, hdrs?: Record<string, string>) {
      state.statusCode = status;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          state.headers[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
        }
      }
      state.headersSent = true;
      state.emitter.emit("headers");
      return resObj as unknown as ServerResponse;
    },
    setHeader(name: string, value: string | string[]) {
      state.headers[name.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
      return resObj as unknown as ServerResponse;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    hasHeader(name: string) {
      return name.toLowerCase() in state.headers;
    },
    removeHeader(name: string) {
      delete state.headers[name.toLowerCase()];
    },
    getHeaderNames() {
      return Object.keys(state.headers);
    },
    write(chunk: string | Uint8Array, cb?: () => void) {
      pushChunk(state, chunk);
      state.headersSent = true;
      if (cb) queueMicrotask(cb);
      return true;
    },
    end(chunk?: string | Uint8Array, cb?: () => void) {
      if (chunk) pushChunk(state, chunk);
      if (!state.ended) {
        state.ended = true;
        state.headersSent = true;
        pushChunk(state); // تنبيه المنتظرين بالانتهاء
        state.emitter.emit("headers");
        state.emitter.emit("finish");
        state.emitter.emit("close");
      }
      if (cb) queueMicrotask(cb);
      return resObj as unknown as ServerResponse;
    },
    flushHeaders() {
      if (!state.headersSent) {
        state.headersSent = true;
        state.emitter.emit("headers");
      }
    },
    on(ev: string, cb: (...a: unknown[]) => void) {
      state.emitter.on(ev, cb);
      return resObj as unknown as ServerResponse;
    },
    once(ev: string, cb: (...a: unknown[]) => void) {
      state.emitter.once(ev, cb);
      return resObj as unknown as ServerResponse;
    },
    off(ev: string, cb: (...a: unknown[]) => void) {
      state.emitter.off(ev, cb);
      return resObj as unknown as ServerResponse;
    },
  };
  const res = resObj as unknown as ServerResponse;

  // ---------- Response تيار يُبنى بعد أول writeHead ----------
  const response = (): Promise<Response> =>
    new Promise<Response>((resolve) => {
      const build = () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            const step = (): Promise<void> =>
              new Promise((done) => {
                const next = () => {
                  if (state.queue.length > 0) {
                    controller.enqueue(state.queue.shift()!);
                    done();
                    return;
                  }
                  if (state.ended) {
                    try {
                      controller.close();
                    } catch {
                      /* أُغلق مسبقًا */
                    }
                    done();
                    return;
                  }
                  state.waiters.push(next); // انتظر بيانات جديدة
                };
                next();
              });
            return step();
          },
          cancel() {
            // العميل قطع البث — نُنهي الـ res نحو الـ transport
            state.ended = true;
            pushChunk(state);
            state.emitter.emit("close");
            req.emit("close");
          },
        });
        const outHeaders = new Headers(state.headers);
        // CORS مفتوح — عملاء MCP من المتصفح يحتاجونه
        outHeaders.set("Access-Control-Allow-Origin", "*");
        outHeaders.set("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
        resolve(new Response(body, { status: state.statusCode, headers: outHeaders }));
      };

      if (state.headersSent || state.ended) {
        build();
        return;
      }
      const timeout = setTimeout(() => {
        // احتياط: إن لم يكتب الـ transport أي شيء خلال مهلة — رد خطأ داخلي
        if (!state.headersSent && !state.ended) {
          state.statusCode = 500;
          state.headers["content-type"] = "application/json";
          resObj.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "No response from transport" }, id: null }));
        }
        build();
      }, 5_000);
      timeout.unref?.();
      state.emitter.once("headers", () => {
        clearTimeout(timeout);
        build();
      });
    });

  return { req, res, response };
}
