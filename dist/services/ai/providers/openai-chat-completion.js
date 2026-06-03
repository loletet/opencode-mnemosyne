import { BaseAIProvider, applySafeExtraParams, } from "./base-provider.js";
import { log, logger } from "../../logger.js";
import { UserProfileValidator } from "../validators/user-profile-validator.js";
function isErrorResponseBody(data) {
    return (typeof data === "object" &&
        data !== null &&
        typeof data.status === "string" &&
        typeof data.msg === "string");
}
function hasNonEmptyChoices(data) {
    if (typeof data !== "object" || data === null)
        return false;
    const { choices } = data;
    if (!Array.isArray(choices) || choices.length === 0)
        return false;
    const first = choices[0];
    if (typeof first !== "object" || first === null)
        return false;
    if (typeof first.message !== "object" || first.message === null)
        return false;
    const { content, tool_calls } = first.message;
    if (content !== undefined && content !== null && typeof content !== "string")
        return false;
    if (tool_calls !== undefined && !Array.isArray(tool_calls))
        return false;
    return true;
}
export class OpenAIChatCompletionProvider extends BaseAIProvider {
    aiSessionManager;
    constructor(config, aiSessionManager) {
        super(config);
        this.aiSessionManager = aiSessionManager;
    }
    getProviderName() {
        return "openai-chat";
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
        messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content,
        });
    }
    filterIncompleteToolCallSequences(messages) {
        const result = [];
        let i = 0;
        while (i < messages.length) {
            const msg = messages[i];
            if (!msg) {
                break;
            }
            if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
                const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.id));
                const toolResponses = [];
                let j = i + 1;
                while (j < messages.length && messages[j]?.role === "tool") {
                    const toolMessage = messages[j];
                    if (toolMessage?.toolCallId && toolCallIds.has(toolMessage.toolCallId)) {
                        toolResponses.push(toolMessage);
                        toolCallIds.delete(toolMessage.toolCallId);
                    }
                    j++;
                }
                if (toolCallIds.size === 0) {
                    result.push(msg);
                    toolResponses.forEach((tr) => result.push(tr));
                    i = j;
                }
                else {
                    break;
                }
            }
            else {
                result.push(msg);
                i++;
            }
        }
        return result;
    }
    async executeToolCall(systemPrompt, userPrompt, toolSchema, sessionId) {
        let session = this.aiSessionManager.getSession(sessionId, "openai-chat");
        logger.info("auto-capture.inference.http", "openai-chat executeToolCall started", {
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
                provider: "openai-chat",
                sessionId,
            });
            logger.info("auto-capture.inference.http", "openai-chat AI session created", {
                sessionId,
                aiSessionId: session.id,
            });
        }
        const existingMessages = this.aiSessionManager.getMessages(session.id);
        const messages = [];
        const validatedMessages = this.filterIncompleteToolCallSequences(existingMessages);
        for (const msg of validatedMessages) {
            const apiMsg = {
                role: msg.role,
                content: msg.content,
            };
            if (msg.toolCalls) {
                apiMsg.tool_calls = msg.toolCalls;
            }
            if (msg.toolCallId) {
                apiMsg.tool_call_id = msg.toolCallId;
            }
            messages.push(apiMsg);
        }
        if (messages.length === 0) {
            const sequence = this.aiSessionManager.getLastSequence(session.id) + 1;
            this.aiSessionManager.addMessage({
                aiSessionId: session.id,
                sequence,
                role: "system",
                content: systemPrompt,
            });
            messages.push({ role: "system", content: systemPrompt });
        }
        const userSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
        this.aiSessionManager.addMessage({
            aiSessionId: session.id,
            sequence: userSequence,
            role: "user",
            content: userPrompt,
        });
        messages.push({ role: "user", content: userPrompt });
        let iterations = 0;
        const maxIterations = this.config.maxIterations ?? 5;
        const iterationTimeout = this.config.iterationTimeout ?? 30000;
        while (iterations < maxIterations) {
            iterations++;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), iterationTimeout);
            try {
                const requestBody = {
                    model: this.config.model,
                    messages,
                    tools: [toolSchema],
                    tool_choice: "auto",
                };
                if (this.config.memoryTemperature !== false) {
                    requestBody.temperature = this.config.memoryTemperature ?? 0.3;
                }
                if (this.config.extraParams) {
                    applySafeExtraParams(requestBody, this.config.extraParams);
                }
                const headers = {
                    "Content-Type": "application/json",
                };
                if (this.config.apiKey) {
                    headers.Authorization = `Bearer ${this.config.apiKey}`;
                }
                logger.info("auto-capture.inference.http", "openai-chat HTTP request starting", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    maxIterations,
                    iterationTimeout,
                    url: `${this.config.apiUrl}/chat/completions`,
                    model: this.config.model,
                    messageCount: messages.length,
                    toolName: toolSchema.function.name,
                    hasTemperature: requestBody.temperature !== undefined,
                    extraParamKeys: this.config.extraParams
                        ? Object.keys(this.config.extraParams).join(",")
                        : "",
                });
                const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                logger.info("auto-capture.inference.http", "openai-chat HTTP response received", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    status: response.status,
                    ok: response.ok,
                    statusText: response.statusText,
                });
                if (!response.ok) {
                    const errorText = await response.text().catch(() => response.statusText);
                    log("OpenAI Chat Completion API error", {
                        provider: this.getProviderName(),
                        model: this.config.model,
                        status: response.status,
                        error: errorText,
                        iteration: iterations,
                    });
                    let errorMessage = `API error: ${response.status} - ${errorText}`;
                    if (response.status === 400 &&
                        errorText.includes("unsupported_value") &&
                        errorText.includes("temperature")) {
                        errorMessage =
                            'Your model does not support the temperature parameter. Add "memoryTemperature": false to your config file to disable it.';
                    }
                    return {
                        success: false,
                        error: errorMessage,
                        iterations,
                    };
                }
                const data = await response.json();
                logger.info("auto-capture.inference.http", "openai-chat response JSON parsed", {
                    sessionId,
                    aiSessionId: session.id,
                    iteration: iterations,
                    hasChoices: Array.isArray(data.choices),
                    choicesLength: Array.isArray(data.choices)
                        ? (data.choices?.length ?? 0)
                        : undefined,
                });
                if (isErrorResponseBody(data)) {
                    log("API returned error in response body", {
                        provider: this.getProviderName(),
                        model: this.config.model,
                        status: data.status,
                        msg: data.msg,
                    });
                    return {
                        success: false,
                        error: `API error: ${data.status} - ${data.msg}`,
                        iterations,
                    };
                }
                if (!hasNonEmptyChoices(data)) {
                    const choices = typeof data === "object" && data !== null
                        ? data.choices
                        : undefined;
                    log("Invalid API response format", {
                        provider: this.getProviderName(),
                        model: this.config.model,
                        response: JSON.stringify(data).slice(0, 1000),
                        hasChoices: Array.isArray(choices),
                        choicesLength: Array.isArray(choices) ? choices.length : undefined,
                    });
                    return {
                        success: false,
                        error: "Invalid API response format",
                        iterations,
                    };
                }
                const choice = data.choices[0];
                if (!choice) {
                    return {
                        success: false,
                        error: "Invalid API response format",
                        iterations,
                    };
                }
                const assistantSequence = this.aiSessionManager.getLastSequence(session.id) + 1;
                const assistantMsg = {
                    aiSessionId: session.id,
                    sequence: assistantSequence,
                    role: "assistant",
                    content: choice.message.content ?? "",
                };
                if (choice.message.tool_calls) {
                    assistantMsg.toolCalls = choice.message.tool_calls;
                }
                this.aiSessionManager.addMessage(assistantMsg);
                messages.push({
                    role: "assistant",
                    content: choice.message.content ?? null,
                    tool_calls: choice.message.tool_calls,
                });
                if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
                    logger.info("auto-capture.inference.http", "openai-chat tool calls returned", {
                        sessionId,
                        aiSessionId: session.id,
                        iteration: iterations,
                        toolCallCount: choice.message.tool_calls.length,
                        toolNames: choice.message.tool_calls.map((tc) => tc.function.name).join(","),
                    });
                    for (const toolCall of choice.message.tool_calls) {
                        const toolCallId = toolCall.id;
                        if (toolCall.function.name === toolSchema.function.name) {
                            try {
                                const parsed = JSON.parse(toolCall.function.arguments);
                                const result = UserProfileValidator.validate(parsed);
                                if (!result.valid) {
                                    throw new Error(result.errors.join(", "));
                                }
                                this.addToolResponse(session.id, messages, toolCallId, JSON.stringify({ success: true }));
                                return {
                                    success: true,
                                    data: result.data,
                                    iterations,
                                };
                            }
                            catch (validationError) {
                                const errorStack = validationError instanceof Error ? validationError.stack : undefined;
                                log("OpenAI tool response validation failed", {
                                    error: validationError,
                                    stack: errorStack,
                                    errorType: validationError instanceof Error
                                        ? validationError.constructor.name
                                        : typeof validationError,
                                    toolName: toolSchema.function.name,
                                    iteration: iterations,
                                    rawArguments: toolCall.function.arguments.slice(0, 500),
                                });
                                const errorMessage = `Validation failed: ${String(validationError)}`;
                                this.addToolResponse(session.id, messages, toolCallId, JSON.stringify({ success: false, error: errorMessage }));
                                return {
                                    success: false,
                                    error: errorMessage,
                                    iterations,
                                };
                            }
                        }
                        const wrongToolMessage = `Wrong tool called. Please use ${toolSchema.function.name} instead.`;
                        this.addToolResponse(session.id, messages, toolCallId, JSON.stringify({ success: false, error: wrongToolMessage }));
                        break;
                    }
                }
                else {
                    logger.info("auto-capture.inference.http", "openai-chat response had no tool call", {
                        sessionId,
                        aiSessionId: session.id,
                        iteration: iterations,
                        finishReason: choice.finish_reason,
                        contentLength: choice.message.content?.length ?? 0,
                    });
                }
                const retrySequence = this.aiSessionManager.getLastSequence(session.id) + 1;
                const retryPrompt = "Please use the save_memories tool to extract and save the memories from the conversation as instructed.";
                this.aiSessionManager.addMessage({
                    aiSessionId: session.id,
                    sequence: retrySequence,
                    role: "user",
                    content: retryPrompt,
                });
                messages.push({ role: "user", content: retryPrompt });
            }
            catch (error) {
                clearTimeout(timeout);
                logger.error("auto-capture.inference.http", "openai-chat executeToolCall iteration failed", error, {
                    sessionId,
                    iteration: iterations,
                    model: this.config.model,
                    apiUrl: this.config.apiUrl,
                });
                if (error instanceof Error && error.name === "AbortError") {
                    return {
                        success: false,
                        error: `API request timeout (${iterationTimeout}ms)`,
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
            error: `Max iterations (${maxIterations}) reached without tool call`,
            iterations,
        };
    }
}
