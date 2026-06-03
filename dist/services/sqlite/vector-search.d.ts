import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import type { VectorBackend } from "../vector-backends/types.js";
declare const Database: typeof import("bun:sqlite").Database;
type DatabaseType = typeof Database.prototype;
export declare class VectorSearch {
    private readonly backendPromise;
    private readonly fallbackBackend;
    constructor(backend?: VectorBackend, fallbackBackend?: VectorBackend);
    private getBackend;
    insertVector(db: DatabaseType, record: MemoryRecord, shard?: ShardInfo): Promise<void>;
    searchInShard(shard: ShardInfo, queryVector: Float32Array, containerTag: string, limit: number, queryText?: string): Promise<SearchResult[]>;
    searchAcrossShards(shards: ShardInfo[], queryVector: Float32Array, containerTag: string, limit: number, similarityThreshold: number, queryText?: string): Promise<SearchResult[]>;
    deleteVector(db: DatabaseType, memoryId: string, shard?: ShardInfo): Promise<void>;
    updateVector(db: DatabaseType, memoryId: string, vector: Float32Array, shard?: ShardInfo, tagsVector?: Float32Array): Promise<void>;
    listMemories(db: DatabaseType, containerTag: string, limit: number): any[];
    getAllMemories(db: DatabaseType): any[];
    getMemoryById(db: DatabaseType, memoryId: string): any | null;
    getMemoriesBySessionID(db: DatabaseType, sessionID: string): any[];
    countVectors(db: DatabaseType, containerTag: string): number;
    countAllVectors(db: DatabaseType): number;
    getDistinctTags(db: DatabaseType): any[];
    pinMemory(db: DatabaseType, memoryId: string): void;
    unpinMemory(db: DatabaseType, memoryId: string): void;
    rebuildIndexForShard(db: DatabaseType, scope: string, scopeHash: string, shardIndex: number): Promise<void>;
    deleteShardIndexes(shard: ShardInfo): Promise<void>;
}
export declare const vectorSearch: VectorSearch;
export {};
//# sourceMappingURL=vector-search.d.ts.map