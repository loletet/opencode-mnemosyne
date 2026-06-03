import { BaseAIProvider } from "./base-provider.js";
import { AISessionManager } from "../session/ai-session-manager.js";
import { log, logger } from "../../logger.js";
import { UserProfileValidator } from "../validators/user-profile-validator.js";
/**
 * Google Gemini Provider
 * Supports Google's Gemini models (e.g. gemini-1.5-flash) via Google AI Studio API.
 */
export class GoogleGeminiProvider extends BaseAIProvider {
    aiSessionManager;
    constructor(config, aiSessionManager) {
        super(config);
        this.aiSessionManager = aiSessionManager;
    }
    getProviderName() {
        return "google-gemini";
    }
    supportsSession() {
        return true;
    }
    addToolResponse(sessionId, messages, toolCallId, content) {
        const sequence = this.aiSessionManager.getLastSequence(sessionId) + 1;
        this.aiSessionManager.addMessage({
            aiSessionId: sessionId,
            sequence,
            role: "tool",
            content,
            toolCallId,
        });
        // Gemini tool response format
        messages.push({
            role: "function",
            parts: [
                {
                    functionResponse: {
                        name: toolCallId.split(":")[0], // Gemini expects the name of the function
                        response: JSON.parse(content),
                    },
                },
            ],
        });
    }
    async executeToolCall(systemPrompt, userPrompt, toolSchema, sessionId) {
        let session = this.aiSessionManager.getSession(sessionId, "google-gemini");
        logger.info("auto-capture.inference.http", "gemini executeToolCall started", {
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
                provider: "google-gemini",
                sessionId,
            });
            logger.info("auto-capture.inference.http", "gemini AI session created", {
                sessionId,
                aiSessionId: session.id,
            });
        }
        const existingMessages = this.aiSessionManager.getMessages(session.id);
        const contents = [];
        // System instruction is separate in Gemini API
        const geminiSystemInstruction = {
            parts: [{ text: systemPrompt }],
        };
        // Convert existing messages to Gemini format
        for (const msg of existingMessages) {
            if (msg.role === "system")
                continue; // Skip system as it's passed separately
            const role = msg.role === "assistant" ? "model" : "user";
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    parts.push({
                        functionCall: {
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments),
                        },
                    });
                }
            }
            if (msg.role === "tool") {
                contents.push({
                    role: "function",
                    parts: [
                        {
                            functionResponse: {
                                name: (msg.toolCallId || "").split(":")[0],
                                response: JSON.parse(msg.content),
                            },
                        },
                    ],
                });
                continue;
            }
            contents.push({ role, parts });
        }
        if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
            const userSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
            this.aiSessionManager.addMessage({
                aiSessionId: session.id,
                sequence: userSequence,
                role: "user",
                content: userPrompt,
            });
            contents.push({ role: "user", parts: [{ text: userPrompt }] });
        }
        let iterations = 0;
        const maxIterations = this.config.maxIterations ?? 5;
        const iterationTimeout = this.config.iterationTimeout ?? 30000;
        // Gemini API expects the tool name as a function declaration
        const tools = [
            {
                functionDeclarations: [
                    {
                        name: toolSchema.function.name,
                        description: toolSchema.function.description,
                        parameters: toolSchema.function.parameters,
                    },
                ],
            },
        ];
        while (iterations < maxIterations) {
            iterations++;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), iterationTimeout);
            try {
                const baseUrl = this.config.apiUrl || "https://generativelanguage.googleapis.com/v1beta";
                const url = `${baseUrl}/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;
                const requestBody = {
                    contents,
                    systemInstruction: geminiSystemInstruction,
                    tools,
                    toolConfig: {
                        functionCallingConfig: {
                            mode: "ANY", // Force function calling
                            allowedFunctionNames: [toolSchema.function.name],
                        },
                    },
                    generationConfig: {
                        temperature: this.config.memoryTemperature ?? 0.3,
                    },
                };
                logger.info("auto-capture.inference.http", "gemini HTTP request starting", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    maxIterations,
                    iterationTimeout,
                    url: `${baseUrl}/models/${this.config.model}:generateContent`,
                    model: this.config.model,
                    contentCount: contents.length,
                    toolName: toolSchema.function.name,
                });
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                logger.info("auto-capture.inference.http", "gemini HTTP response received", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    status: response.status,
                    ok: response.ok,
                    statusText: response.statusText,
                });
                if (!response.ok) {
                    const errorText = await response.text().catch(() => response.statusText);
                    log("Gemini API error", {
                        provider: this.getProviderName(),
                        model: this.config.model,
                        status: response.status,
                        error: errorText,
                        iteration: iterations,
                    });
                    return {
                        success: false,
                        error: `Gemini API error: ${response.status} - ${errorText}`,
                        iterations,
                    };
                }
                const data = (await response.json());
                logger.info("auto-capture.inference.http", "gemini response JSON parsed", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    candidateCount: Array.isArray(data.candidates) ? data.candidates.length : undefined,
                });
                const candidate = data.candidates?.[0];
                if (!candidate || !candidate.content) {
                    return { success: false, error: "Invalid Gemini API response format", iterations };
                }
                const modelMsg = candidate.content;
                const assistantSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
                // Map Gemini response back to our internal message format
                const assistantMsg = {
                    aiSessionId: session.id,
                    sequence: assistantSequence,
                    role: "assistant",
                    content: "",
                    toolCalls: [],
                };
                for (const part of modelMsg.parts) {
                    if (part.text)
                        assistantMsg.content += part.text;
                    if (part.functionCall) {
                        assistantMsg.toolCalls.push({
                            id: `${part.functionCall.name}:${Date.now()}`,
                            type: "function",
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args),
                            },
                        });
                    }
                }
                this.aiSessionManager.addMessage(assistantMsg);
                contents.push(modelMsg);
                if (assistantMsg.toolCalls.length > 0) {
                    logger.info("auto-capture.inference.http", "gemini tool calls returned", {
                        sessionId,
                        aiSessionId: session.id,
                        iteration: iterations,
                        toolCallCount: assistantMsg.toolCalls.length,
                        toolNames: assistantMsg.toolCalls.map((tc) => tc.function.name).join(","),
                    });
                    for (const toolCall of assistantMsg.toolCalls) {
                        if (toolCall.function.name === toolSchema.function.name) {
                            try {
                                const parsed = JSON.parse(toolCall.function.arguments);
                                const result = UserProfileValidator.validate(parsed);
                                if (!result.valid)
                                    throw new Error(result.errors.join(", "));
                                this.addToolResponse(session.id, contents, toolCall.id, JSON.stringify({ success: true }));
                                return { success: true, data: result.data, iterations };
                            }
                            catch (validationError) {
                                const errorMessage = `Validation failed: ${String(validationError)}`;
                                this.addToolResponse(session.id, contents, toolCall.id, JSON.stringify({ success: false, error: errorMessage }));
                                return { success: false, error: errorMessage, iterations };
                            }
                        }
                    }
                }
                // Retry if no tool call was made
                const retryPrompt = "Please use the save_memories tool as instructed.";
                logger.info("auto-capture.inference.http", "gemini response had no tool call; retrying", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                });
                const retrySequence = this.aiSessionManager.getLastSequence(session.id) + 1;
                this.aiSessionManager.addMessage({
                    aiSessionId: session.id,
                    sequence: retrySequence,
                    role: "user",
                    content: retryPrompt,
                });
                contents.push({ role: "user", parts: [{ text: retryPrompt }] });
            }
            catch (error) {
                clearTimeout(timeout);
                logger.error("auto-capture.inference.http", "gemini executeToolCall iteration failed", error, {
                    sessionId,
                    iteration: iterations,
                    model: this.config.model,
                    apiUrl: this.config.apiUrl,
                });
                return { success: false, error: String(error), iterations };
            }
        }
        return { success: false, error: `Max iterations (${maxIterations}) reached`, iterations };
    }
}
