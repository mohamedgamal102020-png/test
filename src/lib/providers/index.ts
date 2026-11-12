// فهرس المزودات — يجلب المحوّل المناسب حسب معرّف المزود
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}
