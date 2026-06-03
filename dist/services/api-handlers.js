import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { log, readLastEntries, parseEntries, getLogPath, subscribe, logger, } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
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
function extractScopeFromTag(tag) {
    const parts = tag.split("_");
    if (parts.length >= 3) {
        const hash = parts.slice(2).join("_");
        return { scope: "project", hash };
    }
    return { scope: "project", hash: tag };
}
function getProjectPathFromTag(tag) {
    const projectShards = shardManager.getAllShards("project", "");
    for (const shard of projectShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const tags = vectorSearch.getDistinctTags(db);
        for (const t of tags) {
            if (t.container_tag === tag && t.project_path) {
                return t.project_path;
            }
        }
    }
    return undefined;
}
export async function handleListTags() {
    try {
        // Tags are stored as SQLite metadata; embedding model is not needed.
        // Calling warmup() here would block on local transformer init in the worker
        // thread and hang every read API. Only handlers that compute similarity
        // (e.g. handleSearch) should warm up the embedding service.
        const projectShards = shardManager.getAllShards("project", "");
        const tagsMap = new Map();
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const tags = vectorSearch.getDistinctTags(db);
            for (const t of tags) {
                if (t.container_tag && !tagsMap.has(t.container_tag)) {
                    tagsMap.set(t.container_tag, {
                        tag: t.container_tag,
                        displayName: t.display_name,
                        userName: t.user_name,
                        userEmail: t.user_email,
                        projectPath: t.project_path,
                        projectName: t.project_name,
                        gitRepoUrl: t.git_repo_url,
                    });
                }
            }
        }
        const projectTags = [];
        for (const tagInfo of tagsMap.values()) {
            if (tagInfo.tag.includes("_project_")) {
                projectTags.push(tagInfo);
            }
        }
        return { success: true, data: { project: projectTags } };
    }
    catch (error) {
        log("handleListTags: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleListMemories(tag, page = 1, pageSize = 20, includePrompts = true) {
    try {
        // Listing only reads SQLite rows; no vector ops happen here.
        // See handleListTags comment - keep embedding init out of read paths.
        let allMemories = [];
        if (tag) {
            const { scope: tagScope, hash } = extractScopeFromTag(tag);
            const shards = shardManager.getAllShards(tagScope, hash);
            for (const shard of shards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const memories = vectorSearch.listMemories(db, tag, 10000);
                allMemories.push(...memories);
            }
        }
        else {
            const shards = shardManager.getAllShards("project", "");
            for (const shard of shards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const memories = vectorSearch.getAllMemories(db);
                allMemories.push(...memories.filter((m) => m.container_tag?.includes(`_project_`)));
            }
        }
        const memoriesWithType = allMemories.map((r) => {
            const metadata = safeJSONParse(r.metadata);
            return {
                type: "memory",
                id: r.id,
                content: r.content,
                memoryType: r.type,
                tags: r.tags ? r.tags.split(",").map((t) => t.trim()) : [],
                createdAt: Number(r.created_at),
                updatedAt: r.updated_at ? Number(r.updated_at) : undefined,
                metadata,
                linkedPromptId: metadata?.promptId,
                displayName: r.display_name,
                userName: r.user_name,
                userEmail: r.user_email,
                projectPath: r.project_path,
                projectName: r.project_name,
                gitRepoUrl: r.git_repo_url,
                isPinned: r.is_pinned === 1,
            };
        });
        let timeline = memoriesWithType;
        if (includePrompts) {
            const projectPath = tag ? getProjectPathFromTag(tag) : undefined;
            const prompts = userPromptManager.getCapturedPrompts(projectPath);
            const promptsWithType = prompts.map((p) => ({
                type: "prompt",
                id: p.id,
                sessionId: p.sessionId,
                content: p.content,
                createdAt: p.createdAt,
                projectPath: p.projectPath,
                linkedMemoryId: p.linkedMemoryId,
            }));
            timeline = [...memoriesWithType, ...promptsWithType];
        }
        const linkedPairs = new Map();
        const standalone = [];
        for (const item of timeline) {
            if (item.type === "memory" && item.linkedPromptId) {
                if (!linkedPairs.has(item.linkedPromptId)) {
                    linkedPairs.set(item.linkedPromptId, { memory: item, prompt: null });
                }
                else {
                    linkedPairs.get(item.linkedPromptId).memory = item;
                }
            }
            else if (item.type === "prompt" && item.linkedMemoryId) {
                if (!linkedPairs.has(item.id)) {
                    linkedPairs.set(item.id, { memory: null, prompt: item });
                }
                else {
                    linkedPairs.get(item.id).prompt = item;
                }
            }
            else {
                standalone.push(item);
            }
        }
        const sortedTimeline = [];
        const pairs = Array.from(linkedPairs.values())
            .filter((p) => p.memory && p.prompt)
            .sort((a, b) => b.memory.createdAt - a.memory.createdAt);
        for (const pair of pairs) {
            sortedTimeline.push(pair.memory);
            sortedTimeline.push(pair.prompt);
        }
        standalone.sort((a, b) => b.createdAt - a.createdAt);
        sortedTimeline.push(...standalone);
        timeline = sortedTimeline;
        const total = timeline.length;
        const totalPages = Math.ceil(total / pageSize);
        const offset = (page - 1) * pageSize;
        const paginatedResults = timeline.slice(offset, offset + pageSize);
        const items = paginatedResults.map((item) => {
            if (item.type === "memory") {
                return {
                    type: "memory",
                    id: item.id,
                    content: item.content,
                    memoryType: item.memoryType,
                    tags: item.tags,
                    createdAt: safeToISOString(item.createdAt),
                    updatedAt: item.updatedAt ? safeToISOString(item.updatedAt) : undefined,
                    metadata: item.metadata,
                    linkedPromptId: item.linkedPromptId,
                    displayName: item.displayName,
                    userName: item.userName,
                    userEmail: item.userEmail,
                    projectPath: item.projectPath,
                    projectName: item.projectName,
                    gitRepoUrl: item.gitRepoUrl,
                    isPinned: item.isPinned,
                };
            }
            else {
                return {
                    type: "prompt",
                    id: item.id,
                    sessionId: item.sessionId,
                    content: item.content,
                    createdAt: safeToISOString(item.createdAt),
                    projectPath: item.projectPath,
                    linkedMemoryId: item.linkedMemoryId,
                };
            }
        });
        return { success: true, data: { items, total, page, pageSize, totalPages } };
    }
    catch (error) {
        log("handleListMemories: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleAddMemory(data) {
    try {
        if (!data.content || !data.containerTag) {
            return { success: false, error: "content and containerTag are required" };
        }
        await embeddingService.warmup();
        const tags = (data.tags || []).map((t) => t.trim().toLowerCase());
        const embeddingInput = tags.length > 0 ? `${data.content}\nTags: ${tags.join(", ")}` : data.content;
        const vector = await embeddingService.embedWithTimeout(embeddingInput);
        let tagsVector = undefined;
        if (tags.length > 0) {
            tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
        }
        const { scope, hash } = extractScopeFromTag(data.containerTag);
        const shard = shardManager.getWriteShard(scope, hash);
        const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const now = Date.now();
        const record = {
            id,
            content: data.content,
            vector,
            tagsVector,
            containerTag: data.containerTag,
            tags: tags.length > 0 ? tags.join(",") : undefined,
            type: data.type,
            createdAt: now,
            updatedAt: now,
            displayName: data.displayName,
            userName: data.userName,
            userEmail: data.userEmail,
            projectPath: data.projectPath,
            projectName: data.projectName,
            gitRepoUrl: data.gitRepoUrl,
            metadata: JSON.stringify({ source: "api" }),
        };
        const db = connectionManager.getConnection(shard.dbPath);
        await vectorSearch.insertVector(db, record, shard);
        shardManager.incrementVectorCount(shard.id);
        return { success: true, data: { id } };
    }
    catch (error) {
        log("handleAddMemory: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleDeleteMemory(id, cascade = false) {
    try {
        if (!id)
            return { success: false, error: "id is required" };
        const projectShards = shardManager.getAllShards("project", "");
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memory = vectorSearch.getMemoryById(db, id);
            if (memory) {
                if (cascade) {
                    const metadata = safeJSONParse(memory.metadata);
                    const linkedPromptId = metadata?.promptId;
                    if (linkedPromptId)
                        userPromptManager.deletePrompt(linkedPromptId);
                }
                await vectorSearch.deleteVector(db, id, shard);
                shardManager.decrementVectorCount(shard.id);
                return {
                    success: true,
                    data: { deletedPrompt: cascade && !!safeJSONParse(memory.metadata)?.promptId },
                };
            }
        }
        return { success: false, error: "Memory not found" };
    }
    catch (error) {
        log("handleDeleteMemory: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleBulkDelete(ids, cascade = false) {
    try {
        if (!ids || ids.length === 0)
            return { success: false, error: "ids array is required" };
        let deleted = 0;
        for (const id of ids) {
            const result = await handleDeleteMemory(id, cascade);
            if (result.success)
                deleted++;
        }
        return { success: true, data: { deleted } };
    }
    catch (error) {
        log("handleBulkDelete: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleUpdateMemory(id, data) {
    try {
        if (!id)
            return { success: false, error: "id is required" };
        await embeddingService.warmup();
        const projectShards = shardManager.getAllShards("project", "");
        let foundShard = null, existingMemory = null;
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memory = vectorSearch.getMemoryById(db, id);
            if (memory) {
                foundShard = shard;
                existingMemory = memory;
                break;
            }
        }
        if (!foundShard || !existingMemory)
            return { success: false, error: "Memory not found" };
        const db = connectionManager.getConnection(foundShard.dbPath);
        await vectorSearch.deleteVector(db, id, foundShard);
        shardManager.decrementVectorCount(foundShard.id);
        const newContent = data.content || existingMemory.content;
        const tags = data.tags || (existingMemory.tags ? existingMemory.tags.split(",") : []);
        const vector = await embeddingService.embedWithTimeout(newContent);
        let tagsVector = undefined;
        if (tags.length > 0) {
            tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
        }
        const updatedRecord = {
            id,
            content: newContent,
            vector,
            tagsVector,
            containerTag: existingMemory.container_tag,
            tags: tags.length > 0 ? tags.join(",") : undefined,
            type: data.type || existingMemory.type,
            createdAt: existingMemory.created_at,
            updatedAt: Date.now(),
            metadata: existingMemory.metadata,
            displayName: existingMemory.display_name,
            userName: existingMemory.user_name,
            userEmail: existingMemory.user_email,
            projectPath: existingMemory.project_path,
            projectName: existingMemory.project_name,
            gitRepoUrl: existingMemory.git_repo_url,
        };
        await vectorSearch.insertVector(db, updatedRecord, foundShard);
        shardManager.incrementVectorCount(foundShard.id);
        return { success: true };
    }
    catch (error) {
        log("handleUpdateMemory: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleSearch(query, tag, page = 1, pageSize = 20) {
    try {
        if (!query)
            return { success: false, error: "query is required" };
        await embeddingService.warmup();
        const queryVector = await embeddingService.embedWithTimeout(query);
        let memoryResults = [];
        let promptResults = [];
        if (tag) {
            const { scope, hash } = extractScopeFromTag(tag);
            const shards = shardManager.getAllShards(scope, hash);
            for (const shard of shards) {
                try {
                    const results = await vectorSearch.searchInShard(shard, queryVector, tag, pageSize * 2);
                    memoryResults.push(...results);
                }
                catch (error) {
                    log("Shard search error", { shardId: shard.id, error });
                }
            }
            const projectPath = getProjectPathFromTag(tag);
            promptResults = userPromptManager.searchPrompts(query, projectPath, pageSize * 2);
        }
        else {
            const projectShards = shardManager.getAllShards("project", "");
            const uniqueTags = new Set();
            for (const shard of projectShards) {
                const db = connectionManager.getConnection(shard.dbPath);
                const tags = vectorSearch.getDistinctTags(db);
                for (const t of tags) {
                    if (t.container_tag)
                        uniqueTags.add(t.container_tag);
                }
            }
            for (const containerTag of uniqueTags) {
                const { scope, hash } = extractScopeFromTag(containerTag);
                const shards = shardManager.getAllShards(scope, hash);
                for (const shard of shards) {
                    try {
                        const results = await vectorSearch.searchInShard(shard, queryVector, containerTag, pageSize);
                        memoryResults.push(...results);
                    }
                    catch (error) {
                        log("Shard search error", { shardId: shard.id, error });
                    }
                }
            }
            promptResults = userPromptManager.searchPrompts(query, undefined, pageSize * 2);
        }
        const formattedPrompts = promptResults.map((p) => ({
            type: "prompt",
            id: p.id,
            sessionId: p.sessionId,
            content: p.content,
            createdAt: safeToISOString(p.createdAt),
            projectPath: p.projectPath,
            linkedMemoryId: p.linkedMemoryId,
            similarity: 1.0,
        }));
        const formattedMemories = memoryResults.map((r) => ({
            type: "memory",
            id: r.id,
            content: r.memory,
            memoryType: r.metadata?.type,
            tags: r.tags,
            createdAt: safeToISOString(r.metadata?.createdAt),
            updatedAt: r.metadata?.updatedAt ? safeToISOString(r.metadata.updatedAt) : undefined,
            similarity: r.similarity,
            metadata: r.metadata,
            displayName: r.displayName,
            userName: r.userName,
            userEmail: r.userEmail,
            projectPath: r.projectPath,
            projectName: r.projectName,
            gitRepoUrl: r.gitRepoUrl,
            isPinned: r.isPinned === 1,
            linkedPromptId: r.metadata?.promptId,
        }));
        const combinedResults = [...formattedMemories, ...formattedPrompts].sort((a, b) => (b.similarity || 0) - (a.similarity || 0) || b.createdAt.localeCompare(a.createdAt));
        const total = combinedResults.length;
        const totalPages = Math.ceil(total / pageSize);
        const offset = (page - 1) * pageSize;
        const paginatedResults = combinedResults.slice(offset, offset + pageSize);
        const missingPromptIds = new Set();
        const missingMemoryIds = new Set();
        for (const item of paginatedResults) {
            if (item.type === "memory" && item.linkedPromptId) {
                if (!paginatedResults.some((p) => p.id === item.linkedPromptId))
                    missingPromptIds.add(item.linkedPromptId);
            }
            else if (item.type === "prompt" && item.linkedMemoryId) {
                if (!paginatedResults.some((m) => m.id === item.linkedMemoryId))
                    missingMemoryIds.add(item.linkedMemoryId);
            }
        }
        if (missingPromptIds.size > 0) {
            const extraPrompts = userPromptManager.getPromptsByIds(Array.from(missingPromptIds));
            for (const p of extraPrompts) {
                paginatedResults.push({
                    type: "prompt",
                    id: p.id,
                    sessionId: p.sessionId,
                    content: p.content,
                    createdAt: safeToISOString(p.createdAt),
                    projectPath: p.projectPath,
                    linkedMemoryId: p.linkedMemoryId,
                    similarity: 0,
                    isContext: true,
                });
            }
        }
        if (missingMemoryIds.size > 0) {
            const projectShards = shardManager.getAllShards("project", "");
            for (const shard of projectShards) {
                const db = connectionManager.getConnection(shard.dbPath);
                for (const mid of missingMemoryIds) {
                    const m = vectorSearch.getMemoryById(db, mid);
                    if (m && !paginatedResults.some((existing) => existing.id === m.id)) {
                        paginatedResults.push({
                            type: "memory",
                            id: m.id,
                            content: m.content,
                            memoryType: m.type,
                            tags: m.tags ? m.tags.split(",").map((t) => t.trim()) : [],
                            createdAt: safeToISOString(m.created_at),
                            updatedAt: m.updated_at ? safeToISOString(m.updated_at) : undefined,
                            similarity: 0,
                            metadata: safeJSONParse(m.metadata),
                            displayName: m.display_name,
                            userName: m.user_name,
                            userEmail: m.user_email,
                            projectPath: m.project_path,
                            projectName: m.project_name,
                            gitRepoUrl: m.git_repo_url,
                            isPinned: m.is_pinned === 1,
                            linkedPromptId: safeJSONParse(m.metadata)?.promptId,
                            isContext: true,
                        });
                    }
                }
            }
        }
        return { success: true, data: { items: paginatedResults, total, page, pageSize, totalPages } };
    }
    catch (error) {
        log("handleSearch: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleStats() {
    try {
        // Stats only counts SQLite rows; no embedding needed.
        // See handleListTags comment - keep embedding init out of read paths.
        const projectShards = shardManager.getAllShards("project", "");
        let userCount = 0, projectCount = 0;
        const typeCount = {};
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memories = vectorSearch.getAllMemories(db);
            for (const r of memories) {
                if (r.container_tag?.includes("_user_"))
                    userCount++;
                else if (r.container_tag?.includes("_project_"))
                    projectCount++;
                if (r.type)
                    typeCount[r.type] = (typeCount[r.type] || 0) + 1;
            }
        }
        return {
            success: true,
            data: {
                total: userCount + projectCount,
                byScope: { user: userCount, project: projectCount },
                byType: typeCount,
            },
        };
    }
    catch (error) {
        log("handleStats: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handlePinMemory(id) {
    try {
        if (!id)
            return { success: false, error: "id is required" };
        const projectShards = shardManager.getAllShards("project", "");
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memory = vectorSearch.getMemoryById(db, id);
            if (memory) {
                vectorSearch.pinMemory(db, id);
                return { success: true };
            }
        }
        return { success: false, error: "Memory not found" };
    }
    catch (error) {
        log("handlePinMemory: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleUnpinMemory(id) {
    try {
        if (!id)
            return { success: false, error: "id is required" };
        const projectShards = shardManager.getAllShards("project", "");
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memory = vectorSearch.getMemoryById(db, id);
            if (memory) {
                vectorSearch.unpinMemory(db, id);
                return { success: true };
            }
        }
        return { success: false, error: "Memory not found" };
    }
    catch (error) {
        log("handleUnpinMemory: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleRunCleanup() {
    try {
        const { cleanupService } = await import("./cleanup-service.js");
        const result = await cleanupService.runCleanup();
        return { success: true, data: result };
    }
    catch (error) {
        log("handleRunCleanup: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleRunDeduplication() {
    try {
        const { deduplicationService } = await import("./deduplication-service.js");
        const result = await deduplicationService.detectAndRemoveDuplicates();
        return { success: true, data: result };
    }
    catch (error) {
        log("handleRunDeduplication: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleDetectMigration() {
    try {
        const { migrationService } = await import("./migration-service.js");
        const result = await migrationService.detectDimensionMismatch();
        return { success: true, data: result };
    }
    catch (error) {
        log("handleDetectMigration: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleRunMigration(strategy) {
    try {
        const { migrationService } = await import("./migration-service.js");
        const result = await migrationService.migrateToNewModel(strategy);
        return { success: result.success, data: result };
    }
    catch (error) {
        log("handleRunMigration: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleDeletePrompt(id, cascade = false) {
    try {
        if (!id)
            return { success: false, error: "id is required" };
        const prompt = userPromptManager.getPromptById(id);
        if (!prompt)
            return { success: false, error: "Prompt not found" };
        let deletedMemory = false;
        if (cascade && prompt.linkedMemoryId) {
            const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
            if (result.success)
                deletedMemory = true;
        }
        userPromptManager.deletePrompt(id);
        return { success: true, data: { deletedMemory } };
    }
    catch (error) {
        log("handleDeletePrompt: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleBulkDeletePrompts(ids, cascade = false) {
    try {
        if (!ids || ids.length === 0)
            return { success: false, error: "ids array is required" };
        let deleted = 0;
        for (const id of ids) {
            const result = await handleDeletePrompt(id, cascade);
            if (result.success)
                deleted++;
        }
        return { success: true, data: { deleted } };
    }
    catch (error) {
        log("handleBulkDeletePrompts: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleGetUserProfile(userId) {
    try {
        const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
        const { getTags } = await import("./tags.js");
        let targetUserId = userId;
        if (!targetUserId) {
            const tags = getTags(process.cwd());
            targetUserId = tags.user.userEmail || "unknown";
        }
        const profile = userProfileManager.getActiveProfile(targetUserId);
        if (!profile)
            return {
                success: true,
                data: {
                    exists: false,
                    userId: targetUserId,
                    message: "No profile found. Keep chatting to build your profile.",
                },
            };
        const profileData = JSON.parse(profile.profileData);
        return {
            success: true,
            data: {
                exists: true,
                id: profile.id,
                userId: profile.userId,
                displayName: profile.displayName,
                userName: profile.userName,
                userEmail: profile.userEmail,
                version: profile.version,
                createdAt: safeToISOString(profile.createdAt),
                lastAnalyzedAt: safeToISOString(profile.lastAnalyzedAt),
                totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
                profileData,
            },
        };
    }
    catch (error) {
        log("handleGetUserProfile: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleGetProfileChangelog(profileId, limit = 5) {
    try {
        if (!profileId)
            return { success: false, error: "profileId is required" };
        const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
        const changelogs = userProfileManager.getProfileChangelogs(profileId, limit);
        const formattedChangelogs = changelogs.map((c) => ({
            id: c.id,
            profileId: c.profileId,
            version: c.version,
            changeType: c.changeType,
            changeSummary: c.changeSummary,
            createdAt: safeToISOString(c.createdAt),
        }));
        return { success: true, data: formattedChangelogs };
    }
    catch (error) {
        log("handleGetProfileChangelog: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleGetProfileSnapshot(changelogId) {
    try {
        if (!changelogId)
            return { success: false, error: "changelogId is required" };
        const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
        const changelogs = userProfileManager.getProfileChangelogs("", 1000);
        const changelog = changelogs.find((c) => c.id === changelogId);
        if (!changelog)
            return { success: false, error: "Changelog not found" };
        const profileData = JSON.parse(changelog.profileDataSnapshot);
        return {
            success: true,
            data: {
                version: changelog.version,
                createdAt: safeToISOString(changelog.createdAt),
                profileData,
            },
        };
    }
    catch (error) {
        log("handleGetProfileSnapshot: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleRefreshProfile(userId) {
    try {
        const { getTags } = await import("./tags.js");
        const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");
        let targetUserId = userId;
        if (!targetUserId) {
            const tags = getTags(process.cwd());
            targetUserId = tags.user.userEmail || "unknown";
        }
        const unanalyzedCount = userPromptManager.countUnanalyzedForUserLearning();
        return {
            success: true,
            data: {
                message: "Profile refresh queued",
                unanalyzedPrompts: unanalyzedCount,
                note: "Profile will be updated when threshold is reached",
            },
        };
    }
    catch (error) {
        log("handleRefreshProfile: error", { error });
        return { success: false, error: String(error) };
    }
}
export async function handleDetectTagMigration() {
    try {
        const projectShards = shardManager.getAllShards("project", "");
        let untaggedCount = 0;
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const rows = db
                .prepare("SELECT COUNT(*) as count FROM memories WHERE tags IS NULL OR tags = ''")
                .get();
            untaggedCount += rows.count;
        }
        return { success: true, data: { needsMigration: untaggedCount > 0, count: untaggedCount } };
    }
    catch (error) {
        return { success: false, error: String(error) };
    }
}
let migrationProgress = {
    processed: 0,
    total: 0,
    currentBatch: 0,
    totalBatches: 0,
    isComplete: true,
    errors: [],
};
export async function handleGetTagMigrationProgress() {
    return { success: true, data: migrationProgress };
}
export async function handleRunTagMigrationBatch(batchSize = 5) {
    try {
        const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
        const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
        const providerConfig = buildMemoryProviderConfig(CONFIG, {
            maxIterations: 1,
            iterationTimeout: 30000,
        });
        const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
        const projectShards = shardManager.getAllShards("project", "");
        let batchProcessed = 0;
        const allMemories = [];
        for (const shard of projectShards) {
            const db = connectionManager.getConnection(shard.dbPath);
            const memories = db.prepare("SELECT * FROM memories").all();
            for (const m of memories) {
                allMemories.push({ memory: m, shard });
            }
        }
        if (migrationProgress.total === 0) {
            migrationProgress.total = allMemories.length;
            migrationProgress.totalBatches = Math.ceil(allMemories.length / batchSize);
            migrationProgress.isComplete = false;
        }
        const startIdx = migrationProgress.processed;
        const endIdx = Math.min(startIdx + batchSize, allMemories.length);
        for (let i = startIdx; i < endIdx; i++) {
            const item = allMemories[i];
            if (!item)
                continue;
            const { memory: m, shard } = item;
            const db = connectionManager.getConnection(shard.dbPath);
            try {
                let currentTags = m.tags
                    ? m.tags
                        .split(",")
                        .map((t) => t.trim().toLowerCase())
                        .filter((t) => t)
                    : [];
                if (currentTags.length === 0) {
                    const prompt = `Generate 2-4 short technical tags for this memory content:\n\n${m.content}\n\nReturn ONLY a comma-separated list of tags.`;
                    const result = await provider.executeToolCall("You are a technical tagger.", prompt, {
                        type: "function",
                        function: {
                            name: "save_tags",
                            description: "Save generated tags",
                            parameters: {
                                type: "object",
                                properties: { tags: { type: "array", items: { type: "string" } } },
                                required: ["tags"],
                            },
                        },
                    }, `migration_${m.id}`);
                    if (result.success && result.data?.tags) {
                        currentTags = result.data.tags;
                        db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(currentTags.join(","), m.id);
                    }
                }
                const vector = await embeddingService.embedWithTimeout(m.content);
                const tagsVector = currentTags.length
                    ? await embeddingService.embedWithTimeout(currentTags.join(", "))
                    : undefined;
                const vectorBuffer = new Uint8Array(vector.buffer);
                db.prepare("UPDATE memories SET vector = ?, updated_at = ? WHERE id = ?").run(vectorBuffer, Date.now(), m.id);
                await vectorSearch.updateVector(db, m.id, vector, shard, tagsVector);
                migrationProgress.processed++;
                batchProcessed++;
            }
            catch (e) {
                const errorMsg = String(e);
                migrationProgress.errors.push(errorMsg);
                log("Migration error for memory", { id: m.id, error: errorMsg });
            }
        }
        migrationProgress.currentBatch++;
        const hasMore = migrationProgress.processed < migrationProgress.total;
        if (!hasMore) {
            migrationProgress.isComplete = true;
        }
        return {
            success: true,
            data: { processed: migrationProgress.processed, total: migrationProgress.total, hasMore },
        };
    }
    catch (error) {
        return { success: false, error: String(error) };
    }
}
// ---------------------------------------------------------------------------
// Logs endpoint
// ---------------------------------------------------------------------------
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
function entryMatchesFilters(entry, minLevel, scopeFilter) {
    if (LEVEL_RANK[entry.level] < LEVEL_RANK[minLevel])
        return false;
    if (scopeFilter && !entry.scope.startsWith(scopeFilter))
        return false;
    return true;
}
/**
 * GET /api/logs?tail=200&minLevel=info&scope=auto-capture&since=ISO
 *
 * Returns the most recent N parsed log entries (after filters).
 * `tail` defaults to 100, capped at 5000. `minLevel` is one of
 * debug|info|warn|error, default info. `scope` is an optional prefix
 * filter. `since` is an optional ISO timestamp; only entries with
 * timestamp >= since are returned.
 */
export function handleGetLogs(params) {
    try {
        const tail = Math.max(1, Math.min(params.tail ?? 100, 5000));
        const minLevel = (params.minLevel ?? "info");
        if (!(minLevel in LEVEL_RANK)) {
            return { success: false, error: `Invalid minLevel: ${minLevel}` };
        }
        const scopeFilter = params.scope?.trim() || null;
        const since = params.since ? new Date(params.since).getTime() : null;
        if (params.since && Number.isNaN(since)) {
            return { success: false, error: `Invalid since timestamp: ${params.since}` };
        }
        // Read more than we need so post-filter still returns tail entries.
        const raw = readLastEntries(Math.max(tail * 3, 500));
        const filtered = raw.filter((e) => entryMatchesFilters(e, minLevel, scopeFilter) &&
            (since === null || new Date(e.timestamp).getTime() >= since));
        const entries = filtered.slice(-tail);
        return {
            success: true,
            data: { entries, total: filtered.length, path: getLogPath() },
        };
    }
    catch (error) {
        log("handleGetLogs: error", { error });
        return { success: false, error: String(error) };
    }
}
/**
 * GET /api/logs/stream?minLevel=info&scope=auto-capture
 *
 * Server-Sent Events stream of new log entries. Each event is one
 * JSON-encoded LogEntry. Closes when the client disconnects.
 *
 * Returns the Response directly (not wrapped in ApiResponse) because
 * SSE needs a streaming Response with specific headers.
 */
export function handleGetLogsStream(params) {
    const minLevel = (params.minLevel ?? "info");
    const scopeFilter = params.scope?.trim() || null;
    let unsub = null;
    let heartbeat = null;
    const stream = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();
            const send = (event, data) => {
                try {
                    controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                }
                catch {
                    // Controller closed underneath us; ignore.
                }
            };
            // Send a hello event so the client knows the stream is alive.
            send("ready", { minLevel, scope: scopeFilter, path: getLogPath() });
            unsub = subscribe((entry) => {
                if (!entryMatchesFilters(entry, minLevel, scopeFilter))
                    return;
                send("entry", entry);
            });
            // Heartbeat every 15s to keep proxies from closing the connection.
            heartbeat = setInterval(() => {
                try {
                    controller.enqueue(enc.encode(`: keep-alive\n\n`));
                }
                catch {
                    // ignore
                }
            }, 15000);
        },
        cancel() {
            if (unsub) {
                unsub();
                unsub = null;
            }
            if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
            }
        },
    });
    const response = new Response(stream, {
        status: 200,
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        },
    });
    return {
        response,
        close: () => {
            if (unsub)
                unsub();
            if (heartbeat)
                clearInterval(heartbeat);
        },
    };
}
// ---------------------------------------------------------------------------
// Auto-capture trigger (debugging aid)
// ---------------------------------------------------------------------------
/**
 * POST /api/auto-capture/trigger
 *
 * Forces the auto-capture pipeline to run on the next idle event
 * instead of waiting 10 seconds. If a sessionID is provided in the
 * body, that session's most recent uncaptured prompt is targeted.
 * Otherwise the most recent uncaptured prompt across all sessions
 * is targeted.
 *
 * Fallback only. The owning WebServer should inject a runtime handler
 * with plugin ctx so the button can run capture synchronously.
 */
export function handleTriggerAutoCapture(params) {
    try {
        logger.info("auto-capture.manual", "fallback trigger endpoint called without runtime handler", {
            requestedSessionID: params.sessionID,
        });
        let prompt;
        if (params.sessionID) {
            prompt = userPromptManager.getLastUncapturedPrompt(params.sessionID);
        }
        else {
            prompt = userPromptManager.getLastUncapturedPromptAny();
        }
        if (!prompt) {
            return {
                success: false,
                error: params.sessionID
                    ? `No uncaptured prompt found for session ${params.sessionID}`
                    : "No uncaptured prompts found across any session",
            };
        }
        logger.info("auto-capture.manual", "fallback trigger found prompt but cannot run inference", {
            promptId: prompt.id,
            sessionId: prompt.sessionId,
            messageId: prompt.messageId,
        });
        return {
            success: false,
            error: "Manual capture runtime handler is not installed. Restart OpenCode so the local Mnemosyne plugin can pass ctx to the web server.",
            data: {
                promptId: prompt.id,
                message: "Found an uncaptured prompt, but this web server instance cannot run inference because it has no plugin runtime handler.",
            },
        };
    }
    catch (error) {
        log("handleTriggerAutoCapture: error", { error });
        return { success: false, error: String(error) };
    }
}
