import { BaseAIProvider, type ToolCallResult, applySafeExtraParams } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import { ToolSchemaConverter, type ChatCompletionTool } from "../tools/tool-schema.js";
import { log, logger } from "../../logger.js";

interface ResponsesAPIOutput {
  id: string;
  object: string;
  model: string;
  output: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: any;
  }>;
  conversation?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class OpenAIResponsesProvider extends BaseAIProvider {
  private aiSessionManager: AISessionManager;

  constructor(config: any, aiSessionManager: AISessionManager) {
    super(config);
    this.aiSessionManager = aiSessionManager;
  }

  getProviderName(): string {
    return "openai-responses";
  }

  supportsSession(): boolean {
    return true;
  }

  async executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: ChatCompletionTool,
    sessionId: string
  ): Promise<ToolCallResult> {
    let session = this.aiSessionManager.getSession(sessionId, "openai-responses");

    logger.info("auto-capture.inference.http", "openai-responses executeToolCall started", {
      sessionId,
      provider: this.getProviderName(),
      model: this.config.model,
      apiUrl: this.config.apiUrl,
      hasApiKey: Boolean(this.config.apiKey),
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
    });

    if (!session) {
      session = this.aiSessionManager.createSession({
        provider: "openai-responses",
        sessionId,
      });
      logger.info("auto-capture.inference.http", "openai-responses AI session created", {
        sessionId,
        aiSessionId: session.id,
      });
    }

    let conversationId = session.conversationId;
    let currentPrompt = userPrompt;
    let iterations = 0;
    const maxIterations = this.config.maxIterations ?? 5;
    const iterationTimeout = this.config.iterationTimeout ?? 30000;

    while (iterations < maxIterations) {
      iterations++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), iterationTimeout);

      try {
        const tool = ToolSchemaConverter.toResponsesAPI(toolSchema);

        const requestBody: any = {
          model: this.config.model,
          input: currentPrompt,
          tools: [tool],
        };

        if (conversationId) {
          requestBody.conversation = conversationId;
        } else {
          requestBody.instructions = systemPrompt;
        }

        if (this.config.extraParams) {
          applySafeExtraParams(requestBody, this.config.extraParams);
        }

        logger.info("auto-capture.inference.http", "openai-responses HTTP request starting", {
          sessionId,
          aiSessionId: session.id,
          iteration: iterations,
          maxIterations,
          iterationTimeout,
          url: `${this.config.apiUrl}/responses`,
          model: this.config.model,
          hasConversationId: Boolean(conversationId),
          toolName: toolSchema.function.name,
          extraParamKeys: this.config.extraParams
            ? Object.keys(this.config.extraParams).join(",")
            : "",
        });

        const response = await fetch(`${this.config.apiUrl}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        logger.info("auto-capture.inference.http", "openai-responses HTTP response received", {
          sessionId,
          aiSessionId: session.id,
          iteration: iterations,
          status: response.status,
          ok: response.ok,
          statusText: response.statusText,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          log("OpenAI Responses API error", {
            provider: this.getProviderName(),
            model: this.config.model,
            status: response.status,
            error: errorText,
            iteration: iterations,
          });
          return {
            success: false,
            error: `API error: ${response.status} - ${errorText}`,
            iterations,
          };
        }

        const data = (await response.json()) as ResponsesAPIOutput;

        logger.info("auto-capture.inference.http", "openai-responses response JSON parsed", {
          sessionId,
          aiSessionId: session.id,
          iteration: iterations,
          outputCount: Array.isArray(data.output) ? data.output.length : undefined,
          conversationId: data.conversation,
          usageInputTokens: data.usage?.input_tokens,
          usageOutputTokens: data.usage?.output_tokens,
        });

        conversationId = data.conversation || conversationId;

        if (iterations === 1) {
          const userSeq = this.aiSessionManager.getLastSequence(session.id) + 1;
          this.aiSessionManager.addMessage({
            aiSessionId: session.id,
            sequence: userSeq,
            role: "user",
            content: userPrompt,
          });
        }

        const toolCall = this.extractToolCall(data, toolSchema.function.name);

        if (toolCall) {
          logger.info("auto-capture.inference.http", "openai-responses tool call extracted", {
            sessionId,
            aiSessionId: session.id,
            iteration: iterations,
            toolName: toolSchema.function.name,
          });
          this.aiSessionManager.updateSession(sessionId, "openai-responses", {
            conversationId,
          });

          return {
            success: true,
            data: this.validateResponse(toolCall),
            iterations,
          };
        }

        currentPrompt = this.buildRetryPrompt(data);
        logger.info("auto-capture.inference.http", "openai-responses retry prompt built", {
          sessionId,
          aiSessionId: session.id,
          iteration: iterations,
          retryPromptLength: currentPrompt.length,
        });
      } catch (error) {
        clearTimeout(timeout);
        logger.error(
          "auto-capture.inference.http",
          "openai-responses executeToolCall iteration failed",
          error,
          {
            sessionId,
            iteration: iterations,
            model: this.config.model,
            apiUrl: this.config.apiUrl,
          }
        );
        if (error instanceof Error && error.name === "AbortError") {
          return {
            success: false,
            error: `API request timeout (${this.config.iterationTimeout}ms)`,
            iterations,
          };
        }
        return {
          success: false,
          error: String(error),
          iterations,
        };
      }
    }

    return {
      success: false,
      error: `Max iterations (${this.config.maxIterations}) reached without tool call`,
      iterations,
    };
  }

  private extractToolCall(data: ResponsesAPIOutput, expectedToolName: string): any | null {
    if (!data.output || !Array.isArray(data.output)) {
      return null;
    }

    for (const item of data.output) {
      if (item.type === "function_call" && item.name === expectedToolName) {
        if (item.arguments) {
          try {
            const parsed = JSON.parse(item.arguments);
            return parsed;
          } catch (error) {
            log("Failed to parse function call arguments", {
              error: String(error),
              toolName: item.name,
              arguments: item.arguments,
            });
            return null;
          }
        } else {
          log("Function call found but no arguments", {
            toolName: item.name,
            callId: item.call_id,
          });
        }
      }
    }

    return null;
  }

  private buildRetryPrompt(data: ResponsesAPIOutput): string {
    let assistantResponse = "";

    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          assistantResponse =
            typeof item.content === "string" ? item.content : JSON.stringify(item.content);
          break;
        }
      }
    }

    return `Previous response: ${assistantResponse}\n\nPlease use the save_memories tool to extract and save the memories from the conversation as instructed.`;
  }

  private validateResponse(data: any): any {
    if (!data || typeof data !== "object") {
      throw new Error("Response is not an object");
    }

    if (Array.isArray(data)) {
      throw new Error("Response cannot be an array");
    }

    const keys = Object.keys(data);
    if (keys.length === 0) {
      throw new Error("Response object is empty");
    }

    for (const key of keys) {
      if (data[key] === undefined || data[key] === null) {
        throw new Error(`Response field '${key}' is null or undefined`);
      }
    }

    return data;
  }
}
