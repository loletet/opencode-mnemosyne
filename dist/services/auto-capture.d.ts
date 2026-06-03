import type { PluginInput } from "@opencode-ai/plugin";
export interface AutoCaptureRunResult {
    success: boolean;
    status: string;
    promptId?: string;
    memoryId?: string;
    summaryType?: string;
    message: string;
}
export declare function performAutoCapture(ctx: PluginInput, sessionID: string, directory: string, options?: {
    promptId?: string;
    trigger?: "idle" | "manual";
}): Promise<AutoCaptureRunResult>;
//# sourceMappingURL=auto-capture.d.ts.map