import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
function safeToISOString(timestamp) {
    try {
        if (timestamp === null || timestamp === undefined) {
            return new Date().toISOString();
        }
        const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);
        if (isNaN(numValue) || numValue < 0) {
            return new Date().toISOString();
        }
        return new Date(numValue).toISOString();
    }
    catch {
        return new Date().toISOString();
    }
}
function safeJSONParse(jsonString) {
    if (!jsonString || typeof jsonString !== "string") {
        return undefined;
    }
    try {
        return JSON.parse(jsonString);
    }
    catch {
        return undefined;
    }
}
function extractScopeFromContainerTag(containerTag) {
    const parts = containerTag.split("_");
    if (parts.length >= 3) {
        const scope = parts[1];
        const hash = parts.slice(2).join("_");
        return { scope, hash };
    }
    return { scope: "user", hash: containerTag };
}
function resolveScopeValue(scope, containerTag) {
    if (scope === "all-projects") {
        return { scope: "project", hash: "" };
    }
    return extractScopeFromContainerTag(containerTag);
}
export class LocalMemoryClient {
    initPromise = null;
    isInitialized = false;
    constructor() { }
    async initialize() {
        if (this.isInitialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = (async () => {
            try {
                this.isInitialized = true;
            }
            catch (error) {
                this.initPromise = null;
                log("SQLite initialization failed", { error });
                throw error;
            }
        })();
        return this.initPromise;
    }
    async warmup(progressCallback) {
        await this.initialize();
        await embeddingService.warmup(progressCallback);
    }
    async isReady() {
        return this.isInitialized && embeddingService.isWarmedUp;
    }
    getStatus() {
        return {
            dbConnected: this.isInitialized,
            modelLoaded: embeddingService.isWarmedUp,
            ready: this.isInitialized && embeddingService.isWarmedUp,
        };
    }
    close() {
        connectionManager.closeAll();
    }
    async searchMemories(query, containerTag, scope = "project") {
        try {
            await this.initialize();
            const queryVector = await embeddingService.embedWithTimeout(query);
            const resolved = resolveScopeValue(scope, containerTag);
            const shards = shardManager.getAllShards(resolved.scope, resolved.hash);
            if (shards.length === 0) {
                return { success: true, results: [], total: 0, timing: 0 };
            }
            const results = await vectorSearch.searchAcrossShards(shards, queryVector, scope === "all-projects" ? "" : containerTag, CONFIG.maxMemories, CONFIG.similarityThreshold, query);
            return { success: true, results, total: results.length, timing: 0 };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("searchMemories: error", { error: errorMessage });
            return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
        }
    }
    async addMemory(content, containerTag, metadata) {
        try {
            await this.initialize();
            const tags = metadata?.tags || [];
            const vector = await embeddingService.embedWithTimeout(content);
            let tagsVector = undefined;
            if (tags.length > 0) {
                tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
            }
            const { scope, hash } = extractScopeFromContainerTag(containerTag);
            const shard = shardManager.getWriteShard(scope, hash);
            const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
            const now = Date.now();
            const { displayName, userName, userEmail, projectPath, projectName, gitRepoUrl, type, tags: _tags, ...dynamicMetadata } = metadata || {};
            const record = {
                id,
                content,
                vector,
                tagsVector,
                containerTag,
                tags: tags.length > 0 ? tags.join(",") : undefined,
                type,
                createdAt: now,
                updatedAt: now,
                displayName,
                userName,
                userEmail,
                projectPath,
                projectName,
                gitRepoUrl,
                metadata: Object.keys(dynamicMetadata).length > 0 ? JSON.stringify(dynamicMetadata) : undefined,
            };
            const db = connectionManager.getConnection(shard.dbPath);
            await vectorSearch.insertVector(db, record, shard);
            shardManager.incrementVectorCount(shard.id);
            return { success: true, id };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("addMemory: error", { error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async deleteMemory(memoryId) {
        try {
            await this.initialize();
            const userShards = shardManager.getAllShards("user", "");
            const projectShards = shardManager.getAllShards("project", "");
            const allShards = [...userShards, ...projectShards];
            for (const shard of allShards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const memory = vectorSearch.getMemoryById(db, memoryId);
                if (memory) {
                    await vectorSearch.deleteVector(db, memoryId, shard);
                    shardManager.decrementVectorCount(shard.id);
                    return { success: true };
                }
            }
            return { success: false, error: "Memory not found" };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("deleteMemory: error", { memoryId, error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async listMemories(containerTag, limit = 20, scope = "project") {
        try {
            await this.initialize();
            const resolved = resolveScopeValue(scope, containerTag);
            const shards = shardManager.getAllShards(resolved.scope, resolved.hash);
            if (shards.length === 0) {
                return {
                    success: true,
                    memories: [],
                    pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
                };
            }
            const allMemories = [];
            for (const shard of shards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const memories = vectorSearch.listMemories(db, scope === "all-projects" ? "" : containerTag, limit);
                allMemories.push(...memories);
            }
            allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            const memories = allMemories.slice(0, limit).map((r) => ({
                id: r.id,
                summary: r.content,
                createdAt: safeToISOString(r.created_at),
                metadata: safeJSONParse(r.metadata),
                displayName: r.display_name,
                userName: r.user_name,
                userEmail: r.user_email,
                projectPath: r.project_path,
                projectName: r.project_name,
                gitRepoUrl: r.git_repo_url,
            }));
            return {
                success: true,
                memories,
                pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("listMemories: error", { error: errorMessage });
            return {
                success: false,
                error: errorMessage,
                memories: [],
                pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
            };
        }
    }
    async searchMemoriesBySessionID(sessionID, containerTag, limit = 10) {
        try {
            await this.initialize();
            const { scope, hash } = extractScopeFromContainerTag(containerTag);
            const shards = shardManager.getAllShards(scope, hash);
            if (shards.length === 0) {
                return { success: true, results: [], total: 0, timing: 0 };
            }
            const allMemories = [];
            for (const shard of shards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const memories = vectorSearch.getMemoriesBySessionID(db, sessionID);
                allMemories.push(...memories);
            }
            allMemories.sort((a, b) => b.created_at - a.created_at);
            const results = allMemories.slice(0, limit).map((row) => ({
                id: row.id,
                memory: row.content,
                similarity: 1.0,
                tags: row.tags || [],
                metadata: row.metadata || {},
                containerTag: row.container_tag,
                displayName: row.display_name,
                userName: row.user_name,
                userEmail: row.user_email,
                projectPath: row.project_path,
                projectName: row.project_name,
                gitRepoUrl: row.git_repo_url,
                createdAt: row.created_at,
            }));
            return { success: true, results, total: results.length, timing: 0 };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("searchMemoriesBySessionID: error", { error: errorMessage });
            return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
        }
    }
}
export const memoryClient = new LocalMemoryClient();
