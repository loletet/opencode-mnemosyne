import type { ShardInfo } from "./types.js";
export declare class ShardManager {
    private metadataDb;
    private metadataPath;
    constructor();
    private initMetadataDb;
    private getShardPath;
    private resolveStoredPath;
    getActiveShard(scope: "user" | "project", scopeHash: string): ShardInfo | null;
    getAllShards(scope: "user" | "project", scopeHash: string): ShardInfo[];
    createShard(scope: "user" | "project", scopeHash: string, shardIndex: number): ShardInfo;
    private initShardDb;
    private isShardValid;
    private ensureShardTables;
    getWriteShard(scope: "user" | "project", scopeHash: string): ShardInfo;
    private markShardReadOnly;
    incrementVectorCount(shardId: number): void;
    decrementVectorCount(shardId: number): void;
    getShardByPath(dbPath: string): ShardInfo | null;
    deleteShard(shardId: number): Promise<void>;
}
export declare const shardManager: ShardManager;
//# sourceMappingURL=shard-manager.d.ts.map