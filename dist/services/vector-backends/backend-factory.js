import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { ExactScanBackend } from "./exact-scan-backend.js";
import { USearchBackend } from "./usearch-backend.js";
class FallbackAwareBackend {
    strategy;
    primary;
    fallback;
    activeBackend;
    constructor(strategy, primary, fallback) {
        this.strategy = strategy;
        this.primary = primary;
        this.fallback = fallback;
        this.activeBackend = primary;
    }
    getBackendName() {
        return this.activeBackend.getBackendName();
    }
    async insert(args) {
        await this.activeBackend.insert(args);
    }
    async insertBatch(args) {
        await this.activeBackend.insertBatch(args);
    }
    async delete(args) {
        await this.activeBackend.delete(args);
    }
    async search(args) {
        try {
            return await this.activeBackend.search(args);
        }
        catch (error) {
            this.logDegrade("search", error);
            this.activeBackend = this.fallback;
            return this.fallback.search(args);
        }
    }
    async rebuildFromShard(args) {
        try {
            await this.activeBackend.rebuildFromShard(args);
        }
        catch (error) {
            this.logDegrade("rebuild", error);
            this.activeBackend = this.fallback;
            await this.fallback.rebuildFromShard(args);
        }
    }
    async deleteShardIndexes(args) {
        await this.primary.deleteShardIndexes(args);
        await this.fallback.deleteShardIndexes(args);
    }
    logDegrade(operation, error) {
        log("Vector backend degraded to exact-scan", {
            strategy: this.strategy,
            severity: this.strategy === "usearch" ? "warning" : "info",
            operation,
            error: String(error),
        });
    }
}
async function defaultUSearchProbe() {
    try {
        await import("usearch");
        return true;
    }
    catch {
        return false;
    }
}
export async function createVectorBackend(options) {
    const exactScanBackend = new ExactScanBackend();
    if (options.vectorBackend === "exact-scan") {
        return exactScanBackend;
    }
    const probeUSearch = options.probeUSearch ?? defaultUSearchProbe;
    if (!(await probeUSearch())) {
        if (options.vectorBackend === "usearch") {
            log("Vector backend degraded to exact-scan", {
                strategy: "usearch",
                severity: "warning",
                operation: "probe",
                error: "USearch unavailable",
            });
        }
        return exactScanBackend;
    }
    try {
        const usearchBackend = options.createUSearchBackend?.() ??
            new USearchBackend({
                baseDir: CONFIG.storagePath,
                dimensions: CONFIG.embeddingDimensions,
            });
        return new FallbackAwareBackend(options.vectorBackend, usearchBackend, exactScanBackend);
    }
    catch (error) {
        log("Vector backend degraded to exact-scan", {
            strategy: options.vectorBackend,
            severity: options.vectorBackend === "usearch" ? "warning" : "info",
            operation: "create",
            error: String(error),
        });
        return exactScanBackend;
    }
}
