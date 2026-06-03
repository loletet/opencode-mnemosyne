import type { AISession, SessionCreateParams, SessionUpdateParams, AIProviderType, AIMessage } from "./session-types.js";
export declare class AISessionManager {
    private db;
    private readonly dbPath;
    private readonly sessionRetentionMs;
    constructor();
    private initDatabase;
    getSession(sessionId: string, provider: AIProviderType): AISession | null;
    createSession(params: SessionCreateParams): AISession;
    updateSession(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): void;
    cleanupExpiredSessions(): number;
    deleteSession(sessionId: string, provider: AIProviderType): void;
    addMessage(message: Omit<AIMessage, "id" | "createdAt">): void;
    getMessages(aiSessionId: string): AIMessage[];
    getLastSequence(aiSessionId: string): number;
    clearMessages(aiSessionId: string): void;
    private rowToSession;
    private rowToMessage;
}
export declare const aiSessionManager: AISessionManager;
//# sourceMappingURL=ai-session-manager.d.ts.map