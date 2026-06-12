import type { ProviderConfig } from "./providers/base-provider.js";
import { logger } from "../logger.js";

interface MemoryProviderRuntimeConfig {
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryTemperature?: number | false;
  memoryExtraParams?: Record<string, unknown>;
  autoCaptureMaxIterations?: number;
  autoCaptureIterationTimeout?: number;
  opencodeProvider?: string;
  opencodeModel?: string;
  memoryProvider?: string;
}

interface ProviderConfigOverrides {
  maxIterations?: number;
  iterationTimeout?: number;
}

export function buildMemoryProviderConfig(
  config: MemoryProviderRuntimeConfig,
  overrides: ProviderConfigOverrides = {}
): ProviderConfig {
  if (!config.memoryModel || !config.memoryApiUrl) {
    const missing: string[] = [];
    if (!config.memoryModel) missing.push("memoryModel");
    if (!config.memoryApiUrl) missing.push("memoryApiUrl");
    const detail =
      `External API not configured for memory provider. ` +
      `Missing: ${missing.join(", ")}. ` +
      `memoryProvider=${config.memoryProvider}, ` +
      `memoryModel=${config.memoryModel}, ` +
      `memoryApiUrl=${config.memoryApiUrl}, ` +
      `hasMemoryApiKey=${Boolean(config.memoryApiKey)}, ` +
      `opencodeProvider=${config.opencodeProvider}, ` +
      `opencodeModel=${config.opencodeModel}.`;
    logger.error(
      "auto-capture.inference",
      "buildMemoryProviderConfig: external API configuration missing",
      {
        missingFields: missing.join(","),
        memoryProvider: config.memoryProvider,
        memoryModel: config.memoryModel,
        memoryApiUrl: config.memoryApiUrl,
        hasMemoryApiKey: Boolean(config.memoryApiKey),
        opencodeProvider: config.opencodeProvider,
        opencodeModel: config.opencodeModel,
      }
    );
    throw new Error(detail);
  }

  return {
    model: config.memoryModel,
    apiUrl: config.memoryApiUrl,
    apiKey: config.memoryApiKey,
    memoryTemperature: config.memoryTemperature,
    extraParams: config.memoryExtraParams,
    maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
    iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
  };
}
