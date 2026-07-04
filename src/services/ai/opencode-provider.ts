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
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { logger } from "../logger.js";

let _connectedProviders: Set<string> = new Set();
let _v2Client: OpencodeClient | undefined;
const _transientSessionIDs: Set<string> = new Set();

export function isTransientSession(sessionID: string): boolean {
  return _transientSessionIDs.has(sessionID);
}

export function setConnectedProviders(providers: string[]): void {
  _connectedProviders = new Set(providers);
  logger.info("auto-capture.inference", "connected opencode providers updated", {
    providers: providers.join(","),
    providerCount: providers.length,
  });
}

export function isProviderConnected(providerName: string): boolean {
  return _connectedProviders.has(providerName);
}

export function setV2Client(client: OpencodeClient): void {
  _v2Client = client;
  logger.info("auto-capture.inference", "opencode v2 client initialized");
}

export function getV2Client(): OpencodeClient | undefined {
  return _v2Client;
}

export function createV2Client(serverUrl: URL | string): OpencodeClient {
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  logger.info("auto-capture.inference", "creating opencode v2 client", { baseUrl });
  return createOpencodeClient({ baseUrl });
}

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
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  const { client, providerID, modelID, systemPrompt, userPrompt, schema, directory, retryCount } =
    opts;

  logger.info("auto-capture.inference", "structured output request preparing", {
    providerID,
    modelID,
    directory,
    retryCount,
    systemPromptLength: systemPrompt.length,
    userPromptLength: userPrompt.length,
  });

  // zod v4 exposes JSON Schema export natively (instance `.toJSONSchema()`
  // and global `z.toJSONSchema()`); we prefer instance, fall back to global.
  // This avoids pulling in a separate `zod-to-json-schema` dependency.
  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  const created = await client.session.create({
    title: "opencode-mnemosyne capture",
    ...(directory ? { directory } : {}),
  });
  const sessionID = (created as { data?: { id?: string } })?.data?.id;
  logger.info("auto-capture.inference", "transient opencode session create returned", {
    providerID,
    modelID,
    sessionID,
    hasData: Boolean((created as { data?: unknown }).data),
  });
  if (!sessionID) {
    throw new Error(
      "opencode-mnemosyne: session.create returned no session id; cannot generate structured output"
    );
  }
  _transientSessionIDs.add(sessionID);

  try {
    logger.info("auto-capture.inference", "opencode session.prompt request starting", {
      providerID,
      modelID,
      sessionID,
      directory,
      retryCount,
    });

    const promptResult = await client.session.prompt({
      sessionID,
      ...(directory ? { directory } : {}),
      model: { providerID, modelID },
      system: systemPrompt,
      parts: [{ type: "text", text: userPrompt }],
      format: {
        type: "json_schema",
        schema: jsonSchema as Record<string, unknown>,
        ...(retryCount !== undefined ? { retryCount } : {}),
      },
      noReply: true,
    });

    const data = (
      promptResult as {
        data?: {
          info?: {
            structured?: unknown;
            error?: { name: string; data?: { message?: string } };
          };
        };
      }
    ).data;

    logger.info("auto-capture.inference", "opencode session.prompt returned", {
      providerID,
      modelID,
      sessionID,
      hasData: Boolean(data),
      hasInfo: Boolean(data?.info),
      hasStructured: data?.info?.structured !== undefined && data?.info?.structured !== null,
      errorName: data?.info?.error?.name,
      errorMessage: data?.info?.error?.data?.message,
    });

    const info = data?.info;
    if (!info) {
      throw new Error("opencode-mnemosyne: prompt response missing `info`");
    }

    if (info.error) {
      const msg = info.error.data?.message ?? info.error.name;
      throw new Error(`opencode-mnemosyne: opencode reported ${info.error.name}: ${msg}`);
    }

    if (info.structured === undefined || info.structured === null) {
      throw new Error(
        "opencode-mnemosyne: opencode returned no structured output (info.structured was empty)"
      );
    }

    const parsed = schema.parse(info.structured);
    logger.info("auto-capture.inference", "structured output schema parse completed", {
      providerID,
      modelID,
      sessionID,
    });
    return parsed;
  } finally {
    // Best-effort: leaving a transient session behind is cosmetic, not
    // worth failing a successful capture if cleanup itself errors.
    try {
      logger.info("auto-capture.inference", "transient opencode session delete starting", {
        providerID,
        modelID,
        sessionID,
      });
      await client.session.delete({
        sessionID,
        ...(directory ? { directory } : {}),
      });
      logger.info("auto-capture.inference", "transient opencode session deleted", {
        providerID,
        modelID,
        sessionID,
      });
    } catch (error) {
      logger.error("auto-capture.inference", "transient opencode session delete failed", error, {
        providerID,
        modelID,
        sessionID,
      });
    }
    _transientSessionIDs.delete(sessionID);
  }
}
