import { shardManager } from "./sqlite/shard-manager.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { embeddingService } from "./embedding.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
export class MigrationService {
    isRunning = false;
    progressCallback;
    async detectDimensionMismatch() {
        const userShards = shardManager.getAllShards("user", "");
        const projectShards = shardManager.getAllShards("project", "");
        const allShards = [...userShards, ...projectShards];
        const mismatches = [];
        for (const shard of allShards) {
            try {
                const db = connectionManager.getConnection(shard.dbPath);
                const metadataResult = db
                    .prepare(`
          SELECT key, value FROM shard_metadata 
          WHERE key IN ('embedding_dimensions', 'embedding_model')
        `)
                    .all();
                const metadata = Object.fromEntries(metadataResult.map((row) => [row.key, row.value]));
                const storedDimensions = parseInt(metadata.embedding_dimensions || "0");
                const storedModel = metadata.embedding_model || "unknown";
                if (storedDimensions !== CONFIG.embeddingDimensions) {
                    const vectorCount = vectorSearch.countAllVectors(db);
                    mismatches.push({
                        shardId: shard.id,
                        dbPath: shard.dbPath,
                        storedDimensions,
                        storedModel,
                        vectorCount,
                    });
                }
            }
            catch (error) {
                log("Migration: error checking shard", {
                    shardId: shard.id,
                    error: String(error),
                });
            }
        }
        return {
            needsMigration: mismatches.length > 0,
            configDimensions: CONFIG.embeddingDimensions,
            configModel: CONFIG.embeddingModel,
            shardMismatches: mismatches,
        };
    }
    async migrateToNewModel(strategy, progressCallback) {
        if (this.isRunning) {
            throw new Error("Migration already running");
        }
        this.isRunning = true;
        this.progressCallback = progressCallback;
        const startTime = Date.now();
        try {
            const mismatch = await this.detectDimensionMismatch();
            if (!mismatch.needsMigration) {
                return {
                    success: true,
                    strategy,
                    deletedShards: 0,
                    reEmbeddedMemories: 0,
                    duration: Date.now() - startTime,
                };
            }
            if (strategy === "fresh-start") {
                return await this.freshStartMigration(mismatch, startTime);
            }
            else {
                return await this.reEmbedMigration(mismatch, startTime);
            }
        }
        catch (error) {
            log("Migration: failed", { error });
            return {
                success: false,
                strategy,
                deletedShards: 0,
                reEmbeddedMemories: 0,
                duration: Date.now() - startTime,
                error: String(error),
            };
        }
        finally {
            this.isRunning = false;
            this.progressCallback = undefined;
        }
    }
    async freshStartMigration(mismatch, startTime) {
        this.reportProgress({
            phase: "preparing",
            processed: 0,
            total: mismatch.shardMismatches.length,
        });
        let deletedShards = 0;
        for (const [index, shardInfo] of mismatch.shardMismatches.entries()) {
            try {
                this.reportProgress({
                    phase: "cleanup",
                    processed: index,
                    total: mismatch.shardMismatches.length,
                    currentShard: String(shardInfo.shardId),
                });
                await shardManager.deleteShard(shardInfo.shardId);
                deletedShards++;
            }
            catch (error) {
                log("Migration: error deleting shard", {
                    shardId: shardInfo.shardId,
                    error: String(error),
                });
            }
        }
        this.reportProgress({
            phase: "complete",
            processed: mismatch.shardMismatches.length,
            total: mismatch.shardMismatches.length,
        });
        return {
            success: true,
            strategy: "fresh-start",
            deletedShards,
            reEmbeddedMemories: 0,
            duration: Date.now() - startTime,
        };
    }
    async reEmbedMigration(mismatch, startTime) {
        await embeddingService.warmup();
        embeddingService.clearCache();
        const totalMemories = mismatch.shardMismatches.reduce((sum, s) => sum + s.vectorCount, 0);
        this.reportProgress({
            phase: "preparing",
            processed: 0,
            total: totalMemories,
        });
        let reEmbeddedCount = 0;
        let processedCount = 0;
        for (const shardInfo of mismatch.shardMismatches) {
            this.reportProgress({
                phase: "re-embedding",
                processed: processedCount,
                total: totalMemories,
                currentShard: String(shardInfo.shardId),
            });
            try {
                const db = connectionManager.getConnection(shardInfo.dbPath);
                const memories = vectorSearch.getAllMemories(db);
                const tempMemories = [];
                for (const memory of memories) {
                    tempMemories.push({
                        id: memory.id,
                        content: memory.content,
                        containerTag: memory.container_tag,
                        type: memory.type,
                        createdAt: memory.created_at,
                        updatedAt: memory.updated_at,
                        metadata: memory.metadata,
                        displayName: memory.display_name,
                        userName: memory.user_name,
                        userEmail: memory.user_email,
                        projectPath: memory.project_path,
                        projectName: memory.project_name,
                        gitRepoUrl: memory.git_repo_url,
                        isPinned: memory.is_pinned || 0,
                    });
                }
                await shardManager.deleteShard(shardInfo.shardId);
                for (const memory of tempMemories) {
                    try {
                        const vector = await embeddingService.embedWithTimeout(memory.content);
                        const scope = memory.containerTag.includes("_user_") ? "user" : "project";
                        const hash = memory.containerTag.split("_").slice(2).join("_");
                        const newShard = shardManager.getWriteShard(scope, hash);
                        const newDb = connectionManager.getConnection(newShard.dbPath);
                        await vectorSearch.insertVector(newDb, {
                            id: memory.id,
                            content: memory.content,
                            vector,
                            containerTag: memory.containerTag,
                            type: memory.type || undefined,
                            createdAt: memory.createdAt,
                            updatedAt: memory.updatedAt,
                            metadata: memory.metadata || undefined,
                            displayName: memory.displayName || undefined,
                            userName: memory.userName || undefined,
                            userEmail: memory.userEmail || undefined,
                            projectPath: memory.projectPath || undefined,
                            projectName: memory.projectName || undefined,
                            gitRepoUrl: memory.gitRepoUrl || undefined,
                        }, newShard);
                        if (memory.isPinned === 1) {
                            vectorSearch.pinMemory(newDb, memory.id);
                        }
                        shardManager.incrementVectorCount(newShard.id);
                        reEmbeddedCount++;
                        processedCount++;
                        this.reportProgress({
                            phase: "re-embedding",
                            processed: processedCount,
                            total: totalMemories,
                            currentShard: String(shardInfo.shardId),
                        });
                    }
                    catch (error) {
                        log("Migration: error re-embedding memory", {
                            memoryId: memory.id,
                            error: String(error),
                        });
                        processedCount++;
                    }
                }
            }
            catch (error) {
                log("Migration: error processing shard", {
                    shardId: shardInfo.shardId,
                    error: String(error),
                });
            }
        }
        this.reportProgress({
            phase: "complete",
            processed: totalMemories,
            total: totalMemories,
        });
        return {
            success: true,
            strategy: "re-embed",
            deletedShards: mismatch.shardMismatches.length,
            reEmbeddedMemories: reEmbeddedCount,
            duration: Date.now() - startTime,
        };
    }
    reportProgress(progress) {
        if (this.progressCallback) {
            this.progressCallback(progress);
        }
    }
    getStatus() {
        return {
            isRunning: this.isRunning,
            configModel: CONFIG.embeddingModel,
            configDimensions: CONFIG.embeddingDimensions,
        };
    }
}
export const migrationService = new MigrationService();
