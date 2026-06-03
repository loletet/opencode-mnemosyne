import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log, logger } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface ToolCallInfo {
  name: string;
  input: string;
}

export interface AutoCaptureRunResult {
  success: boolean;
  status: string;
  promptId?: string;
  memoryId?: string;
  summaryType?: string;
  message: string;
}

const MAX_TOOL_INPUT_LENGTH = 100;

let isCaptureRunning = false;

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  options: { promptId?: string; trigger?: "idle" | "manual" } = {}
): Promise<AutoCaptureRunResult> {
  const trigger = options.trigger ?? "idle";
  if (isCaptureRunning) {
    logger.info("auto-capture", "capture skipped because another capture is running", {
      sessionID,
      trigger,
      promptId: options.promptId,
    });
    return {
      success: false,
      status: "busy",
      promptId: options.promptId,
      message: "Capture skipped because another capture is already running",
    };
  }
  isCaptureRunning = true;
  let claimedPromptId: string | null = null;
  let promptCompleted = false;
  try {
    logger.info("auto-capture", "capture started", {
      sessionID,
      trigger,
      directory,
      requestedPromptId: options.promptId,
      autoCaptureEnabled: CONFIG.autoCaptureEnabled,
      opencodeProvider: CONFIG.opencodeProvider,
      opencodeModel: CONFIG.opencodeModel,
      memoryProvider: CONFIG.memoryProvider,
      memoryModel: CONFIG.memoryModel,
      hasMemoryApiUrl: Boolean(CONFIG.memoryApiUrl),
      hasMemoryApiKey: Boolean(CONFIG.memoryApiKey),
    });

    const prompt = options.promptId
      ? userPromptManager.getUncapturedPromptById(options.promptId)
      : userPromptManager.getLastUncapturedPrompt(sessionID);
    if (!prompt) {
      logger.info("auto-capture", "capture stopped: no uncaptured prompt found", {
        sessionID,
        trigger,
        requestedPromptId: options.promptId,
      });
      return {
        success: false,
        status: "no-prompt",
        promptId: options.promptId,
        message: "No uncaptured prompt found",
      };
    }

    logger.info("auto-capture", "prompt selected", {
      sessionID,
      trigger,
      promptId: prompt.id,
      promptSessionId: prompt.sessionId,
      messageId: prompt.messageId,
      projectPath: prompt.projectPath,
      promptLength: prompt.content.length,
      promptPreview: prompt.content.slice(0, 240),
    });

    if (!userPromptManager.claimPrompt(prompt.id)) {
      logger.info("auto-capture", "capture stopped: prompt claim failed", {
        sessionID,
        trigger,
        promptId: prompt.id,
      });
      return {
        success: false,
        status: "claim-failed",
        promptId: prompt.id,
        message: "Prompt claim failed",
      };
    }
    claimedPromptId = prompt.id;

    logger.info("auto-capture", "prompt claimed", {
      sessionID,
      trigger,
      promptId: prompt.id,
    });

    if (!ctx.client) {
      throw new Error("Client not available");
    }

    logger.info("auto-capture", "loading session messages", {
      sessionID,
      trigger,
      promptId: prompt.id,
    });

    const response = await ctx.client.session.messages({
      path: { id: sessionID },
    });

    if (!response.data) {
      logger.info("auto-capture", "capture stopped: session messages response had no data", {
        sessionID,
        trigger,
        promptId: prompt.id,
      });
      return {
        success: false,
        status: "no-session-message-data",
        promptId: prompt.id,
        message: "Session messages response had no data",
      };
    }

    const messages = response.data;
    logger.info("auto-capture", "session messages loaded", {
      sessionID,
      trigger,
      promptId: prompt.id,
      messageCount: messages.length,
      roles: messages.map((m: any) => m.info?.role ?? "unknown").join(","),
    });

    const promptIndex = messages.findIndex((m: any) => m.info?.id === prompt.messageId);
    if (promptIndex === -1) {
      logger.info("auto-capture", "capture stopped: prompt message not found in session", {
        sessionID,
        trigger,
        promptId: prompt.id,
        messageId: prompt.messageId,
        messageCount: messages.length,
      });
      return {
        success: false,
        status: "prompt-message-not-found",
        promptId: prompt.id,
        message: "Prompt message was not found in the OpenCode session messages",
      };
    }

    const aiMessages = messages.slice(promptIndex + 1);

    if (aiMessages.length === 0) {
      logger.info("auto-capture", "capture stopped: no assistant messages after prompt", {
        sessionID,
        trigger,
        promptId: prompt.id,
        promptIndex,
        messageCount: messages.length,
      });
      return {
        success: false,
        status: "no-assistant-messages",
        promptId: prompt.id,
        message: "No assistant messages found after the selected prompt",
      };
    }

    const { textResponses, toolCalls } = extractAIContent(aiMessages);

    logger.info("auto-capture", "assistant content extracted", {
      sessionID,
      trigger,
      promptId: prompt.id,
      aiMessageCount: aiMessages.length,
      textResponseCount: textResponses.length,
      textResponseLengths: textResponses.map((text) => text.length).join(","),
      toolCallCount: toolCalls.length,
      toolCalls: toolCalls.map((tool) => tool.name).join(","),
    });

    if (textResponses.length === 0 && toolCalls.length === 0) {
      logger.info("auto-capture", "capture stopped: assistant content was empty", {
        sessionID,
        trigger,
        promptId: prompt.id,
      });
      return {
        success: false,
        status: "empty-assistant-content",
        promptId: prompt.id,
        message: "Assistant messages had no text or tool calls to capture",
      };
    }

    const tags = getTags(directory);
    logger.info("auto-capture", "project tags resolved", {
      sessionID,
      trigger,
      promptId: prompt.id,
      projectTag: tags.project.tag,
      projectName: tags.project.projectName,
      projectPath: tags.project.projectPath,
      userEmail: tags.project.userEmail,
    });

    const latestMemory = await getLatestProjectMemory(tags.project.tag);

    logger.info("auto-capture", "latest memory context loaded", {
      sessionID,
      trigger,
      promptId: prompt.id,
      hasLatestMemory: Boolean(latestMemory),
      latestMemoryLength: latestMemory?.length ?? 0,
    });

    const context = buildMarkdownContext(prompt.content, textResponses, toolCalls, latestMemory);

    logger.info("auto-capture", "capture context built", {
      sessionID,
      trigger,
      promptId: prompt.id,
      contextLength: context.length,
      contextPreview: context.slice(0, 500),
    });

    const summaryResult = await generateSummary(context, sessionID, prompt.content);

    logger.info("auto-capture", "summary generation completed", {
      sessionID,
      trigger,
      promptId: prompt.id,
      summaryType: summaryResult?.type,
      summaryLength: summaryResult?.summary.length ?? 0,
      tags: summaryResult?.tags?.join(",") ?? "",
    });

    if (!summaryResult || summaryResult.type === "skip") {
      userPromptManager.deletePrompt(prompt.id);
      promptCompleted = true;
      logger.info("auto-capture", "prompt deleted after skip result", {
        sessionID,
        trigger,
        promptId: prompt.id,
        summaryType: summaryResult?.type,
      });
      return {
        success: true,
        status: "skipped",
        promptId: prompt.id,
        summaryType: summaryResult?.type,
        message: "Inference returned skip; prompt was deleted",
      };
    }

    logger.info("auto-capture", "saving generated memory", {
      sessionID,
      trigger,
      promptId: prompt.id,
      memoryType: summaryResult.type,
      summaryLength: summaryResult.summary.length,
      tags: summaryResult.tags.join(","),
    });

    const result = await memoryClient.addMemory(summaryResult.summary, tags.project.tag, {
      source: "auto-capture" as any,
      type: summaryResult.type as any,
      tags: summaryResult.tags,
      sessionID,
      promptId: prompt.id,
      captureTimestamp: Date.now(),
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: tags.project.projectPath,
      projectName: tags.project.projectName,
      gitRepoUrl: tags.project.gitRepoUrl,
    });

    logger.info("auto-capture", "memory save returned", {
      sessionID,
      trigger,
      promptId: prompt.id,
      success: result.success,
      memoryId: result.id,
      error: result.success ? undefined : result.error,
    });

    if (result.success) {
      userPromptManager.linkMemoryToPrompt(prompt.id, result.id);
      userPromptManager.markAsCaptured(prompt.id);
      promptCompleted = true;

      logger.info("auto-capture", "capture completed", {
        sessionID,
        trigger,
        promptId: prompt.id,
        memoryId: result.id,
      });

      if (CONFIG.showAutoCaptureToasts) {
        await ctx.client?.tui
          .showToast({
            body: {
              title: "Memory Captured",
              message: "Project memory saved from conversation",
              variant: "success",
              duration: 3000,
            },
          })
          .catch(() => {});
      }
      return {
        success: true,
        status: "captured",
        promptId: prompt.id,
        memoryId: result.id,
        summaryType: summaryResult.type,
        message: "Inference completed and memory was saved",
      };
    } else {
      throw new Error(result.error || "memoryClient.addMemory failed without an error message");
    }
  } catch (error) {
    logger.error("auto-capture", "capture failed", error, {
      sessionID,
      trigger,
      promptId: claimedPromptId ?? options.promptId,
    });
    throw error;
  } finally {
    if (claimedPromptId && !promptCompleted) {
      const released = userPromptManager.releasePromptClaim(claimedPromptId);
      logger.info("auto-capture", "prompt claim released after incomplete capture", {
        sessionID,
        trigger,
        promptId: claimedPromptId,
        released,
      });
    }
    isCaptureRunning = false;
    logger.info("auto-capture", "capture lock released", {
      sessionID,
      trigger,
      promptId: claimedPromptId ?? options.promptId,
    });
  }
}

function extractAIContent(messages: any[]): {
  textResponses: string[];
  toolCalls: ToolCallInfo[];
} {
  const textResponses: string[] = [];
  const toolCalls: ToolCallInfo[] = [];

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;

    if (!msg.parts || !Array.isArray(msg.parts)) continue;

    const textParts = msg.parts.filter((p: any) => p.type === "text" && p.text);
    if (textParts.length > 0) {
      const text = textParts.map((p: any) => p.text).join("\n");
      if (text.trim()) {
        textResponses.push(text.trim());
      }
    }

    const toolParts = msg.parts.filter((p: any) => p.type === "tool");
    for (const tool of toolParts) {
      const name = tool.tool || "unknown";
      let input = "";

      if (tool.state?.input) {
        const inputObj = tool.state.input;
        if (typeof inputObj === "string") {
          input = inputObj;
        } else if (typeof inputObj === "object") {
          const params = [];
          for (const [key, value] of Object.entries(inputObj)) {
            params.push(`${key}: ${JSON.stringify(value)}`);
          }
          input = params.join(", ");
        }
      }

      if (input.length > MAX_TOOL_INPUT_LENGTH) {
        input = input.substring(0, MAX_TOOL_INPUT_LENGTH) + "...";
      }

      toolCalls.push({ name, input });
    }
  }

  return { textResponses, toolCalls };
}

async function getLatestProjectMemory(containerTag: string): Promise<string | null> {
  try {
    const result = await memoryClient.listMemories(containerTag, 1);
    if (!result.success || result.memories.length === 0) {
      return null;
    }

    const latest = result.memories[0];
    if (!latest) {
      return null;
    }

    const content = latest.summary;

    if (content.length <= 500) {
      return content;
    }

    return content.substring(0, 500) + "...";
  } catch {
    return null;
  }
}

function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: ToolCallInfo[],
  latestMemory: string | null
): string {
  const sections: string[] = [];

  if (latestMemory) {
    sections.push(`## Previous Memory Context`);
    sections.push(`---`);
    sections.push(latestMemory);
    sections.push(`---\n`);
  }

  sections.push(`## User Request`);
  sections.push(`---`);
  sections.push(userPrompt);
  sections.push(`---\n`);

  if (textResponses.length > 0) {
    sections.push(`## AI Response`);
    sections.push(`---`);
    sections.push(textResponses.join("\n\n"));
    sections.push(`---\n`);
  }

  if (toolCalls.length > 0) {
    sections.push(`## Tools Used`);
    sections.push(`---`);
    for (const tool of toolCalls) {
      if (tool.input) {
        sections.push(`- ${tool.name}(${tool.input})`);
      } else {
        sections.push(`- ${tool.name}`);
      }
    }
    sections.push(`---\n`);
  }

  return sections.join("\n");
}

async function generateSummary(
  context: string,
  sessionID: string,
  userPrompt: string
): Promise<{ summary: string; type: string; tags: string[] } | null> {
  logger.info("auto-capture.inference", "summary generation starting", {
    sessionID,
    contextLength: context.length,
    userPromptLength: userPrompt.length,
    opencodeProvider: CONFIG.opencodeProvider,
    opencodeModel: CONFIG.opencodeModel,
    memoryProvider: CONFIG.memoryProvider,
    memoryModel: CONFIG.memoryModel,
    hasMemoryApiUrl: Boolean(CONFIG.memoryApiUrl),
    hasMemoryApiKey: Boolean(CONFIG.memoryApiKey),
  });

  // Opencode provider path (when opencodeProvider + opencodeModel configured)
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    if (CONFIG.memoryModel) {
      log("opencodeProvider takes precedence over memoryModel for auto-capture");
    }

    logger.info("auto-capture.inference", "using opencode provider path", {
      sessionID,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
    });

    const { isProviderConnected, getV2Client, generateStructuredOutput } =
      await import("./ai/opencode-provider.js");

    if (!isProviderConnected(CONFIG.opencodeProvider)) {
      logger.error(
        "auto-capture.inference",
        "opencode provider is not connected",
        new Error(`opencode provider '${CONFIG.opencodeProvider}' is not connected`),
        {
          sessionID,
          providerID: CONFIG.opencodeProvider,
          modelID: CONFIG.opencodeModel,
        }
      );
      throw new Error(
        `opencode provider '${CONFIG.opencodeProvider}' is not connected. Check your opencode provider configuration.`
      );
    }

    const v2Client = getV2Client();
    if (!v2Client) {
      logger.error(
        "auto-capture.inference",
        "opencode v2 client is not initialized",
        new Error("v2 client not initialized"),
        {
          sessionID,
          providerID: CONFIG.opencodeProvider,
          modelID: CONFIG.opencodeModel,
        }
      );
      throw new Error(
        "opencode-mnemosyne: v2 client not initialized; cannot perform structured-output capture"
      );
    }

    const { detectLanguage, getLanguageName } = await import("./language-detector.js");
    const targetLang =
      CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
        ? detectLanguage(userPrompt)
        : CONFIG.autoCaptureLanguage;
    const langName = getLanguageName(targetLang);

    const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

    const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

    const { z } = await import("zod");
    const schema = z.object({
      summary: z.string(),
      type: z.string(),
      tags: z.array(z.string()),
    });

    logger.info("auto-capture.inference", "calling opencode structured output", {
      sessionID,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
      systemPromptLength: systemPrompt.length,
      aiPromptLength: aiPrompt.length,
    });

    const result = await generateStructuredOutput({
      client: v2Client,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
      systemPrompt,
      userPrompt: aiPrompt,
      schema,
    });

    logger.info("auto-capture.inference", "opencode structured output returned", {
      sessionID,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
      summaryLength: result.summary.length,
      type: result.type,
      tags: (result.tags || []).join(","),
    });

    return {
      summary: result.summary,
      type: result.type,
      tags: (result.tags || []).map((t: string) => t.toLowerCase().trim()),
    };
  }

  // Existing manual config path
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    logger.error(
      "auto-capture.inference",
      "external API configuration missing",
      new Error("External API not configured for auto-capture"),
      {
        sessionID,
        memoryProvider: CONFIG.memoryProvider,
        memoryModel: CONFIG.memoryModel,
        hasMemoryApiUrl: Boolean(CONFIG.memoryApiUrl),
        hasMemoryApiKey: Boolean(CONFIG.memoryApiKey),
      }
    );
    throw new Error("External API not configured for auto-capture");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
  const { detectLanguage, getLanguageName } = await import("./language-detector.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  logger.info("auto-capture.inference", "using external provider path", {
    sessionID,
    memoryProvider: CONFIG.memoryProvider,
    memoryModel: CONFIG.memoryModel,
    memoryApiUrl: CONFIG.memoryApiUrl,
    hasMemoryApiKey: Boolean(CONFIG.memoryApiKey),
    maxIterations: providerConfig.maxIterations,
    iterationTimeout: providerConfig.iterationTimeout,
  });

  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(userPrompt)
      : CONFIG.autoCaptureLanguage;

  const langName = getLanguageName(targetLang);

  const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

  const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Save the conversation summary as a memory",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Markdown-formatted summary of the conversation",
          },
          type: {
            type: "string",
            description:
              "Type of memory: 'skip' for non-technical conversations, or technical type (feature, bug-fix, refactor, analysis, configuration, discussion, other)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "List of 2-4 technical tags related to the memory",
          },
        },
        required: ["summary", "type", "tags"],
      },
    },
  };

  logger.info("auto-capture.inference", "calling external provider tool call", {
    sessionID,
    memoryProvider: CONFIG.memoryProvider,
    memoryModel: CONFIG.memoryModel,
    systemPromptLength: systemPrompt.length,
    aiPromptLength: aiPrompt.length,
  });

  const result = await provider.executeToolCall(systemPrompt, aiPrompt, toolSchema, sessionID);

  logger.info("auto-capture.inference", "external provider tool call returned", {
    sessionID,
    memoryProvider: CONFIG.memoryProvider,
    memoryModel: CONFIG.memoryModel,
    success: result.success,
    hasData: Boolean(result.data),
    error: result.error,
    type: result.data?.type,
    summaryLength: result.data?.summary?.length ?? 0,
    tags: result.data?.tags?.join(",") ?? "",
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return {
    summary: result.data.summary,
    type: result.data.type,
    tags: (result.data.tags || []).map((t: string) => t.toLowerCase().trim()),
  };
}
