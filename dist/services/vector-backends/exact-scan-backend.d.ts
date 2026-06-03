import type { BackendInsertItem, BackendSearchResult, VectorBackend, VectorBackendSearchParams, VectorKind } from "./types.js";
import type { ShardInfo } from "../sqlite/types.js";
interface RankedRow {
    id: string;
    vector: Float32Array;
}
export declare class ExactScanBackend implements VectorBackend {
    getBackendName(): string;
    rankVectors(rows: RankedRow[], queryVector: Float32Array, limit: number): BackendSearchResult[];
    insert(_args: {
        id: string;
        vector: Float32Array;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    insertBatch(_args: {
        items: BackendInsertItem[];
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    delete(_args: {
        id: string;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]>;
    rebuildFromShard(_args: {
        db: unknown;
        shard: ShardInfo;
        kind: VectorKind;
    }): Promise<void>;
    deleteShardIndexes(_args: {
        shard: ShardInfo;
    }): Promise<void>;
    private decodeVector;
    private cosineSimilarity;
}
export {};
//# sourceMappingURL=exact-scan-backend.d.ts.map