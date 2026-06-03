import { BaseAIProvider } from "./providers/base-provider.js";
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { aiSessionManager } from "./session/ai-session-manager.js";
export class AIProviderFactory {
    static createProvider(providerType, config) {
        switch (providerType) {
            case "openai-chat":
                return new OpenAIChatCompletionProvider(config, aiSessionManager);
            case "openai-responses":
                return new OpenAIResponsesProvider(config, aiSessionManager);
            case "anthropic":
                return new AnthropicMessagesProvider(config, aiSessionManager);
            case "google-gemini":
                return new GoogleGeminiProvider(config, aiSessionManager);
            default:
                throw new Error(`Unknown provider type: ${providerType}`);
        }
    }
    static getSupportedProviders() {
        return ["openai-chat", "openai-responses", "anthropic", "google-gemini"];
    }
    static cleanupExpiredSessions() {
        return aiSessionManager.cleanupExpiredSessions();
    }
}
