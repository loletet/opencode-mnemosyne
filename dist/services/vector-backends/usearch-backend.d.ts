import type { BackendInsertItem, BackendSearchResult, VectorBackend, VectorBackendSearchParams, VectorKind } from "./types.js";
import type { ShardInfo } from "../sqlite/types.js";
export declare class USearchBackend implements VectorBackend {
    private readonly options;
    private readonly indexes;
    constructor(options: {
        baseDir: string;
        dimensions: number;
    });
    getBackendName(): string;
    insert(args: {
        id: string;
        vector: Float32Array;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    insertBatch(args: {
        items: BackendInsertItem[];
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    delete(args: {
        id: string;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]>;
    rebuildFromShard(args: {
        db: unknown;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    deleteShardIndexes(args: {
        shard: ShardInfo;
    }): Promise<void>;
    insertManyForTest(indexKey: string, items: BackendInsertItem[]): Promise<void>;
    searchForTest(indexKey: string, queryVector: Float32Array, limit: number): Promise<BackendSearchResult[]>;
    private getOrCreateIndex;
    private createEmptyIndex;
    private ensureKey;
    private addItems;
    private upsertItem;
    private decodeVector;
    private getIndexKey;
    private loadUSearch;
}
//# sourceMappingURL=usearch-backend.d.ts.map