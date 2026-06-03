import type { MemoryType } from "../types/index.js";
export type MemoryScope = "project" | "all-projects";
export declare class LocalMemoryClient {
    private initPromise;
    private isInitialized;
    constructor();
    private initialize;
    warmup(progressCallback?: (progress: any) => void): Promise<void>;
    isReady(): Promise<boolean>;
    getStatus(): {
        dbConnected: boolean;
        modelLoaded: boolean;
        ready: boolean;
    };
    close(): void;
    searchMemories(query: string, containerTag: string, scope?: MemoryScope): Promise<{
        success: true;
        results: import("./sqlite/types.js").SearchResult[];
        total: number;
        timing: number;
        error?: undefined;
    } | {
        success: false;
        error: string;
        results: never[];
        total: number;
        timing: number;
    }>;
    addMemory(content: string, containerTag: string, metadata?: {
        type?: MemoryType;
        source?: "manual" | "auto-capture" | "import" | "api";
        tags?: string[];
        tool?: string;
        sessionID?: string;
        reasoning?: string;
        captureTimestamp?: number;
        displayName?: string;
        userName?: string;
        userEmail?: string;
        projectPath?: string;
        projectName?: string;
        gitRepoUrl?: string;
        [key: string]: unknown;
    }): Promise<{
        success: true;
        id: string;
        error?: undefined;
    } | {
        success: false;
        error: string;
        id?: undefined;
    }>;
    deleteMemory(memoryId: string): Promise<{
        success: boolean;
        error?: undefined;
    } | {
        success: boolean;
        error: string;
    }>;
    listMemories(containerTag: string, limit?: number, scope?: MemoryScope): Promise<{
        success: true;
        memories: {
            id: any;
            summary: any;
            createdAt: string;
            metadata: any;
            displayName: any;
            userName: any;
            userEmail: any;
            projectPath: any;
            projectName: any;
            gitRepoUrl: any;
        }[];
        pagination: {
            currentPage: number;
            totalItems: number;
            totalPages: number;
        };
        error?: undefined;
    } | {
        success: false;
        error: string;
        memories: never[];
        pagination: {
            currentPage: number;
            totalItems: number;
            totalPages: number;
        };
    }>;
    searchMemoriesBySessionID(sessionID: string, containerTag: string, limit?: number): Promise<{
        success: true;
        results: {
            id: any;
            memory: any;
            similarity: number;
            tags: any;
            metadata: any;
            containerTag: any;
            displayName: any;
            userName: any;
            userEmail: any;
            projectPath: any;
            projectName: any;
            gitRepoUrl: any;
            createdAt: any;
        }[];
        total: number;
        timing: number;
        error?: undefined;
    } | {
        success: false;
        error: string;
        results: never[];
        total: number;
        timing: number;
    }>;
}
export declare const memoryClient: LocalMemoryClient;
//# sourceMappingURL=client.d.ts.map