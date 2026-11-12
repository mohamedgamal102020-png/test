// أنواع المزودات + خطأ موحّد يحمل كود HTTP للتصنيف
import type { ErrorClass } from "../classify";

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId
  createTask(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (تعيد النتيجة فورًا)
  createImageSync?(apiKey: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckTaskResult>;
}

export class ProviderError extends Error {
  constructor(
    public status: number | undefined,
    message: string,
    public cls?: ErrorClass
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
