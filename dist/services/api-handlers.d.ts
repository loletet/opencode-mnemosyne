import { type LogEntry } from "./logger.js";
import type { MemoryType } from "../types/index.js";
interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
}
interface Memory {
    id: string;
    content: string;
    type?: string;
    tags?: string[];
    createdAt: string;
    updatedAt?: string;
    metadata?: Record<string, unknown>;
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
    isPinned?: boolean;
}
interface TagInfo {
    tag: string;
    tags?: string[];
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
}
interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}
export declare function handleListTags(): Promise<ApiResponse<{
    project: TagInfo[];
}>>;
export declare function handleListMemories(tag?: string, page?: number, pageSize?: number, includePrompts?: boolean): Promise<ApiResponse<PaginatedResponse<Memory | any>>>;
export declare function handleAddMemory(data: {
    content: string;
    containerTag: string;
    type?: MemoryType;
    tags?: string[];
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
}): Promise<ApiResponse<{
    id: string;
}>>;
export declare function handleDeleteMemory(id: string, cascade?: boolean): Promise<ApiResponse<{
    deletedPrompt: boolean;
}>>;
export declare function handleBulkDelete(ids: string[], cascade?: boolean): Promise<ApiResponse<{
    deleted: number;
}>>;
export declare function handleUpdateMemory(id: string, data: {
    content?: string;
    type?: MemoryType;
    tags?: string[];
}): Promise<ApiResponse<void>>;
interface FormattedPrompt {
    type: "prompt";
    id: string;
    sessionId: string;
    content: string;
    createdAt: string;
    projectPath: string | null;
    linkedMemoryId: string | null;
    similarity?: number;
    isContext?: boolean;
}
interface FormattedMemory {
    type: "memory";
    id: string;
    content: string;
    memoryType?: string;
    tags?: string[];
    createdAt: string;
    updatedAt?: string;
    similarity?: number;
    metadata?: Record<string, unknown>;
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
    isPinned?: boolean;
    linkedPromptId?: string;
    isContext?: boolean;
}
type SearchResultItem = FormattedPrompt | FormattedMemory;
export declare function handleSearch(query: string, tag?: string, page?: number, pageSize?: number): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>>;
export declare function handleStats(): Promise<ApiResponse<{
    total: number;
    byScope: {
        user: number;
        project: number;
    };
    byType: Record<string, number>;
}>>;
export declare function handlePinMemory(id: string): Promise<ApiResponse<void>>;
export declare function handleUnpinMemory(id: string): Promise<ApiResponse<void>>;
export declare function handleRunCleanup(): Promise<ApiResponse<{
    deletedCount: number;
    userCount: number;
    projectCount: number;
}>>;
export declare function handleRunDeduplication(): Promise<ApiResponse<{
    exactDuplicatesDeleted: number;
    nearDuplicateGroups: any[];
}>>;
export declare function handleDetectMigration(): Promise<ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
}>>;
export declare function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
}>>;
export declare function handleDeletePrompt(id: string, cascade?: boolean): Promise<ApiResponse<{
    deletedMemory: boolean;
}>>;
export declare function handleBulkDeletePrompts(ids: string[], cascade?: boolean): Promise<ApiResponse<{
    deleted: number;
}>>;
export declare function handleGetUserProfile(userId?: string): Promise<ApiResponse<any>>;
export declare function handleGetProfileChangelog(profileId: string, limit?: number): Promise<ApiResponse<any[]>>;
export declare function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>>;
export declare function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>>;
export declare function handleDetectTagMigration(): Promise<ApiResponse<{
    needsMigration: boolean;
    count: number;
}>>;
interface MigrationProgress {
    processed: number;
    total: number;
    currentBatch: number;
    totalBatches: number;
    isComplete: boolean;
    errors: string[];
}
export declare function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>>;
export declare function handleRunTagMigrationBatch(batchSize?: number): Promise<ApiResponse<{
    processed: number;
    total: number;
    hasMore: boolean;
}>>;
/**
 * GET /api/logs?tail=200&minLevel=info&scope=auto-capture&since=ISO
 *
 * Returns the most recent N parsed log entries (after filters).
 * `tail` defaults to 100, capped at 5000. `minLevel` is one of
 * debug|info|warn|error, default info. `scope` is an optional prefix
 * filter. `since` is an optional ISO timestamp; only entries with
 * timestamp >= since are returned.
 */
export declare function handleGetLogs(params: {
    tail?: number;
    minLevel?: string;
    scope?: string;
    since?: string;
}): ApiResponse<{
    entries: LogEntry[];
    total: number;
    path: string;
}>;
/**
 * GET /api/logs/stream?minLevel=info&scope=auto-capture
 *
 * Server-Sent Events stream of new log entries. Each event is one
 * JSON-encoded LogEntry. Closes when the client disconnects.
 *
 * Returns the Response directly (not wrapped in ApiResponse) because
 * SSE needs a streaming Response with specific headers.
 */
export declare function handleGetLogsStream(params: {
    minLevel?: string;
    scope?: string;
}): {
    response: Response;
    close: () => void;
};
/**
 * POST /api/auto-capture/trigger
 *
 * Forces the auto-capture pipeline to run on the next idle event
 * instead of waiting 10 seconds. If a sessionID is provided in the
 * body, that session's most recent uncaptured prompt is targeted.
 * Otherwise the most recent uncaptured prompt across all sessions
 * is targeted.
 *
 * Fallback only. The owning WebServer should inject a runtime handler
 * with plugin ctx so the button can run capture synchronously.
 */
export declare function handleTriggerAutoCapture(params: {
    sessionID?: string;
}): ApiResponse<{
    promptId?: string;
    message: string;
}>;
export {};
//# sourceMappingURL=api-handlers.d.ts.map