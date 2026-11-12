// خادم MCP — media-generator-mcp v1.2.0 بالأدوات الخمس
// الأوصاف إنجليزية (يقرأها العميل) — النتائج عربية (يعرضها للمستخدم)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshGenerationTask } from "./generate";
import { runMerge, refreshMergeTask } from "./merge";
import { listRecentTasks, getTask, type TaskRow } from "./tasks";
import {
  fmtNoKeys,
  fmtImageDone,
  fmtVideoDone,
  fmtMergeDone,
  fmtProcessing,
  fmtFailed,
  fmtMergeTooFew,
  fmtMergeResolveErrors,
  fmtTaskNotFound,
  fmtListMedia,
} from "./format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export const TOOL_NAMES = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"] as const;

interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: unknown) => Promise<void>;
  signal?: AbortSignal;
}

/** بث إشعار تقدم حي إذا زوّد العميل الطلب بـ progressToken */
async function notifyProgress(extra: ToolExtra, progress: number, message: string): Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total: 100, message },
    });
  } catch {
    /* العميل قد يكون قطع — نتجاهل */
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** صياغة نتيجة التوليد (صورة/فيديو) — مكتملة أو جارية أو فاشلة */
function formatGenResult(task: TaskRow, outcome: { noKeys?: boolean }, type: "image" | "video"): { text: string; isError: boolean } {
  if (outcome.noKeys) return { text: fmtNoKeys(task.model), isError: false };
  if (task.status === "completed") {
    return { text: type === "image" ? fmtImageDone(task) : fmtVideoDone(task), isError: false };
  }
  if (task.status === "failed") {
    return { text: fmtFailed(task.error_message || "سبب غير معروف"), isError: true };
  }
  return { text: fmtProcessing(task, type), isError: false };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
        "Returns the finished image URL if it completes within the wait window, otherwise returns a task_id — " +
        "then call get_task with it every ~10 seconds until completed (show the URL) or failed.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      }),
    },
    async (args, extra) => {
      const a = args as {
        prompt: string;
        model: string;
        aspect_ratio: string;
        resolution: string;
        background: string;
        output_format: string;
        wait_seconds: number;
      };
      const input: Record<string, unknown> = {
        prompt: a.prompt,
        aspect_ratio: a.aspect_ratio,
        resolution: a.resolution,
        background: a.background,
        output_format: a.output_format,
      };
      const outcome = await runGeneration({
        type: "image",
        modelInput: a.model,
        prompt: a.prompt,
        input,
        waitSeconds: a.wait_seconds,
        onProgress: (p, msg) => notifyProgress(extra as ToolExtra, p, msg),
      });
      const { text, isError } = formatGenResult(outcome.task, outcome, "image");
      return textResult(text, isError);
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue, effects, music; optional image-to-video). " +
        "Video takes minutes: the tool waits briefly with live progress and then returns a task_id — " +
        "track it with get_task every ~10 seconds until completed (show the URL) or failed.",
      inputSchema: z.object({
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      }),
    },
    async (args, extra) => {
      const a = args as {
        prompt: string;
        image_url?: string;
        model: string;
        aspect_ratio: string;
        resolution: string;
        enable_audio: boolean;
        duration: number;
        wait_seconds: number;
      };
      const input: Record<string, unknown> = {
        prompt: a.prompt,
        aspect_ratio: a.aspect_ratio,
        resolution: a.resolution,
        enable_audio: a.enable_audio,
        duration: a.duration,
      };
      if (a.image_url) input.image_url = a.image_url;
      const outcome = await runGeneration({
        type: "video",
        modelInput: a.model,
        prompt: a.prompt,
        input,
        waitSeconds: a.wait_seconds,
        onProgress: (p, msg) => notifyProgress(extra as ToolExtra, p, msg),
      });
      const { text, isError } = formatGenResult(outcome.task, outcome, "video");
      return textResult(text, isError);
    }
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several finished clips into ONE final video in the given order. Pass 'urls' (public direct video links, e.g. from generate_video) " +
        "or 'task_ids' (completed video generation tasks — their result URLs are merged in this order, ideal after generating several clips). " +
        "Merging is usually fast: brief wait with live progress, then a task_id for the merge — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: z.object({
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      }),
    },
    async (args, extra) => {
      const a = args as { urls?: string[]; task_ids?: string[]; wait_seconds: number };
      if ((!a.urls || a.urls.length === 0) && (!a.task_ids || a.task_ids.length === 0)) {
        return textResult(fmtMergeTooFew(), true);
      }
      const outcome = await runMerge({
        urls: a.urls,
        taskIds: a.task_ids,
        waitSeconds: a.wait_seconds,
        onProgress: (p, msg) => notifyProgress(extra as ToolExtra, p, msg),
      });
      if (outcome.errorText) return textResult(outcome.errorText, true);
      const task = outcome.task!;
      if (task.status === "completed") return textResult(fmtMergeDone(task), false);
      if (task.status === "failed") return textResult(fmtFailed(task.error_message || "سبب غير معروف"), true);
      return textResult(fmtProcessing(task, "merge"), false);
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation AND merging (reads the database and refreshes live from the provider or merging service). " +
        "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: z.object({
        task_id: z.string().min(1),
      }),
    },
    async (args) => {
      const a = args as { task_id: string };
      // اتجّه حسب نوع المهمة: الدمج يُحدَّث من خدمة الدمج، والتوليد من المزود
      const preview = await getTask(a.task_id);
      if (!preview) return textResult(fmtTaskNotFound(a.task_id), true);
      const task =
        preview.type === "merge" ? await refreshMergeTask(a.task_id) : await refreshGenerationTask(a.task_id);
      if (!task) return textResult(fmtTaskNotFound(a.task_id), true);

      if (task.status === "completed") {
        if (task.type === "image") return textResult(fmtImageDone(task), false);
        if (task.type === "merge") return textResult(fmtMergeDone(task), false);
        return textResult(fmtVideoDone(task), false);
      }
      if (task.status === "failed") {
        return textResult(fmtFailed(task.error_message || "سبب غير معروف"), true);
      }
      const kind = task.type === "image" ? "image" : task.type === "merge" ? "merge" : "video";
      return textResult(fmtProcessing(task, kind), false);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest images/videos/merges stored with their result URLs from the database (no regeneration) — recall previously generated media.",
      inputSchema: z.object({
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async (args) => {
      const a = args as { type?: string; status?: string; limit: number };
      const tasks = await listRecentTasks(a.limit, { type: a.type, status: a.status });
      return textResult(fmtListMedia(tasks), false);
    }
  );

  return server;
}
