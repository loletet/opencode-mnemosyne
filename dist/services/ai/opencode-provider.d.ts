/**
 * SDK-based structured output via opencode v2 session.prompt.
 *
 * Replaces the old auth.json/OAuth-juggling flow. Instead of forging requests
 * to provider HTTP endpoints ourselves, we delegate to the running opencode
 * server: it already owns the user's auth (any provider, including
 * github-copilot personal/business), token refresh, and provider routing.
 *
 * Per call we create a transient session, prompt with a JSON schema, then
 * delete the session so it does not pollute the user's TUI session list.
 */
import type { z } from "zod";
import { type OpencodeClient } from "@opencode-ai/sdk/v2/client";
export declare function setConnectedProviders(providers: string[]): void;
export declare function isProviderConnected(providerName: string): boolean;
export declare function setV2Client(client: OpencodeClient): void;
export declare function getV2Client(): OpencodeClient | undefined;
export declare function createV2Client(serverUrl: URL | string): OpencodeClient;
export interface StructuredOutputOptions<T> {
    client: OpencodeClient;
    providerID: string;
    modelID: string;
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    directory?: string;
    retryCount?: number;
}
/**
 * Generate one structured-output completion via opencode's v2 API.
 * Throws on: session.create failure, prompt failure, AssistantMessage.error
 * (StructuredOutputError / ApiError / ...), missing `info.structured`,
 * or final Zod validation failure.
 */
export declare function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T>;
//# sourceMappingURL=opencode-provider.d.ts.map