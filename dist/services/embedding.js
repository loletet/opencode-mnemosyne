import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { join } from "node:path";
const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;
let _transformers = null;
function getTransformersPackageSpecifier() {
    // Keep this non-literal so OpenCode/Bun plugin-loader bundling does not eagerly
    // traverse @xenova/transformers internals during plugin startup. The package
    // is only needed for the local embedding backend, and should stay lazy.
    return ["@xenova", "transformers"].join("/");
}
async function ensureTransformersLoaded() {
    if (_transformers !== null)
        return _transformers;
    const mod = (await import(getTransformersPackageSpecifier()));
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = true;
    mod.env.cacheDir = join(CONFIG.storagePath, ".cache");
    // Keep ONNX WASM single-threaded for Bun/Node runtimes without SharedArrayBuffer.
    try {
        mod.env.backends.onnx.wasm.numThreads = 1;
    }
    catch (e) {
        log("Failed to set wasm.numThreads", { error: e });
    }
    _transformers = mod;
    return _transformers;
}
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
}
export class EmbeddingService {
    pipe = null;
    initPromise = null;
    isWarmedUp = false;
    cache = new Map();
    cachedModelName = null;
    static getInstance() {
        if (!globalThis[GLOBAL_EMBEDDING_KEY]) {
            globalThis[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
        }
        return globalThis[GLOBAL_EMBEDDING_KEY];
    }
    async warmup(progressCallback) {
        if (this.isWarmedUp)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.initializeModel(progressCallback);
        return this.initPromise;
    }
    async initializeModel(progressCallback) {
        try {
            if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
                this.isWarmedUp = true;
                return;
            }
            const { pipeline } = await ensureTransformersLoaded();
            this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
                progress_callback: progressCallback,
            });
            this.isWarmedUp = true;
        }
        catch (error) {
            this.initPromise = null;
            log("Failed to initialize embedding model", { error });
            throw error;
        }
    }
    async embed(text) {
        if (this.cachedModelName !== CONFIG.embeddingModel) {
            this.clearCache();
            this.cachedModelName = CONFIG.embeddingModel;
        }
        const cached = this.cache.get(text);
        if (cached)
            return cached;
        if (!this.isWarmedUp && !this.initPromise) {
            await this.warmup();
        }
        if (this.initPromise) {
            await this.initPromise;
        }
        let result;
        if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
            const response = await fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
                },
                body: JSON.stringify({
                    input: text,
                    model: CONFIG.embeddingModel,
                }),
            });
            if (!response.ok) {
                throw new Error(`API embedding failed: ${response.statusText}`);
            }
            const data = await response.json();
            result = new Float32Array(data.data[0].embedding);
        }
        else {
            const output = await this.pipe(text, { pooling: "mean", normalize: true });
            result = new Float32Array(output.data);
        }
        if (this.cache.size >= MAX_CACHE_SIZE) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined)
                this.cache.delete(firstKey);
        }
        this.cache.set(text, result);
        return result;
    }
    async embedWithTimeout(text) {
        return withTimeout(this.embed(text), TIMEOUT_MS);
    }
    clearCache() {
        this.cache.clear();
    }
}
export const embeddingService = EmbeddingService.getInstance();
