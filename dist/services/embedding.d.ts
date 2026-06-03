export declare class EmbeddingService {
    private pipe;
    private initPromise;
    isWarmedUp: boolean;
    private cache;
    private cachedModelName;
    static getInstance(): EmbeddingService;
    warmup(progressCallback?: (progress: any) => void): Promise<void>;
    private initializeModel;
    embed(text: string): Promise<Float32Array>;
    embedWithTimeout(text: string): Promise<Float32Array>;
    clearCache(): void;
}
export declare const embeddingService: EmbeddingService;
//# sourceMappingURL=embedding.d.ts.map