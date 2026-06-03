import { getDatabase } from "../sqlite/sqlite-bootstrap.js";
import { join } from "node:path";
import { connectionManager } from "../sqlite/connection-manager.js";
import { CONFIG } from "../../config.js";
const Database = getDatabase();
const USER_PROMPTS_DB_NAME = "user-prompts.db";
export class UserPromptManager {
    db;
    dbPath;
    constructor() {
        this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
        this.db = connectionManager.getConnection(this.dbPath);
        this.initDatabase();
    }
    initDatabase() {
        this.db.run(`
      CREATE TABLE IF NOT EXISTS user_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        project_path TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        captured BOOLEAN DEFAULT 0,
        user_learning_captured BOOLEAN DEFAULT 0,
        linked_memory_id TEXT
      )
    `);
        this.db.run("UPDATE user_prompts SET captured = 0 WHERE captured = 2");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_linked ON user_prompts(linked_memory_id)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_user_learning ON user_prompts(user_learning_captured)");
    }
    savePrompt(sessionId, messageId, projectPath, content) {
        const id = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const now = Date.now();
        const stmt = this.db.prepare(`
      INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
        stmt.run(id, sessionId, messageId, projectPath, content, now);
        return id;
    }
    getLastUncapturedPrompt(sessionId) {
        const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE session_id = ? AND captured = 0
      ORDER BY created_at DESC
      LIMIT 1
    `);
        const row = stmt.get(sessionId);
        if (!row)
            return null;
        return this.rowToPrompt(row);
    }
    getLastUncapturedPromptAny() {
        const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE captured = 0
      ORDER BY created_at DESC
      LIMIT 1
    `);
        const row = stmt.get();
        if (!row)
            return null;
        return this.rowToPrompt(row);
    }
    getUncapturedPromptById(promptId) {
        const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE id = ? AND captured = 0
      LIMIT 1
    `);
        const row = stmt.get(promptId);
        if (!row)
            return null;
        return this.rowToPrompt(row);
    }
    deletePrompt(promptId) {
        const stmt = this.db.prepare(`DELETE FROM user_prompts WHERE id = ?`);
        stmt.run(promptId);
    }
    markAsCaptured(promptId) {
        const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 1 WHERE id = ?`);
        stmt.run(promptId);
    }
    claimPrompt(promptId) {
        const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 2 WHERE id = ? AND captured = 0`);
        const result = stmt.run(promptId);
        return result.changes > 0;
    }
    releasePromptClaim(promptId) {
        const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 0 WHERE id = ? AND captured = 2`);
        const result = stmt.run(promptId);
        return result.changes > 0;
    }
    countUncapturedPrompts() {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM user_prompts WHERE captured = 0`);
        const row = stmt.get();
        return row?.count || 0;
    }
    getUncapturedPrompts(limit) {
        const stmt = this.db.prepare(`
      SELECT * FROM user_prompts 
      WHERE captured = 0 
      ORDER BY created_at ASC 
      LIMIT ?
    `);
        const rows = stmt.all(limit);
        return rows.map((row) => this.rowToPrompt(row));
    }
    markMultipleAsCaptured(promptIds) {
        if (promptIds.length === 0)
            return;
        const placeholders = promptIds.map(() => "?").join(",");
        const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 1 WHERE id IN (${placeholders})`);
        stmt.run(...promptIds);
    }
    countUnanalyzedForUserLearning() {
        const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = 0`);
        const row = stmt.get();
        return row?.count || 0;
    }
    getPromptsForUserLearning(limit) {
        const stmt = this.db.prepare(`
      SELECT * FROM user_prompts 
      WHERE user_learning_captured = 0 
      ORDER BY created_at ASC 
      LIMIT ?
    `);
        const rows = stmt.all(limit);
        return rows.map((row) => this.rowToPrompt(row));
    }
    markAsUserLearningCaptured(promptId) {
        const stmt = this.db.prepare(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id = ?`);
        stmt.run(promptId);
    }
    markMultipleAsUserLearningCaptured(promptIds) {
        if (promptIds.length === 0)
            return;
        const placeholders = promptIds.map(() => "?").join(",");
        const stmt = this.db.prepare(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id IN (${placeholders})`);
        stmt.run(...promptIds);
    }
    deleteOldPrompts(cutoffTime) {
        const getLinkedStmt = this.db.prepare(`
      SELECT linked_memory_id FROM user_prompts 
      WHERE created_at < ? AND linked_memory_id IS NOT NULL
    `);
        const linkedRows = getLinkedStmt.all(cutoffTime);
        const linkedMemoryIds = linkedRows.map((row) => row.linked_memory_id).filter((id) => id);
        const deleteStmt = this.db.prepare(`DELETE FROM user_prompts WHERE created_at < ?`);
        const result = deleteStmt.run(cutoffTime);
        return {
            deleted: result.changes,
            linkedMemoryIds,
        };
    }
    linkMemoryToPrompt(promptId, memoryId) {
        const stmt = this.db.prepare(`UPDATE user_prompts SET linked_memory_id = ? WHERE id = ?`);
        stmt.run(memoryId, promptId);
    }
    getPromptById(promptId) {
        const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id = ?`);
        const row = stmt.get(promptId);
        if (!row)
            return null;
        return this.rowToPrompt(row);
    }
    getCapturedPrompts(projectPath) {
        let query = `SELECT * FROM user_prompts WHERE captured = 1`;
        const params = [];
        if (projectPath) {
            query += ` AND project_path = ?`;
            params.push(projectPath);
        }
        query += ` ORDER BY created_at DESC`;
        const stmt = this.db.prepare(query);
        const rows = stmt.all(...params);
        return rows.map((row) => this.rowToPrompt(row));
    }
    searchPrompts(query, projectPath, limit = 20) {
        let sql = `SELECT * FROM user_prompts WHERE content LIKE ? AND captured = 1`;
        const params = [`%${query}%`];
        if (projectPath) {
            sql += ` AND project_path = ?`;
            params.push(projectPath);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params);
        return rows.map((row) => this.rowToPrompt(row));
    }
    getPromptsByIds(ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(",");
        const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders})`);
        const rows = stmt.all(...ids);
        return rows.map((row) => this.rowToPrompt(row));
    }
    rowToPrompt(row) {
        return {
            id: row.id,
            sessionId: row.session_id,
            messageId: row.message_id,
            projectPath: row.project_path,
            content: row.content,
            createdAt: row.created_at,
            captured: row.captured === 1,
            userLearningCaptured: row.user_learning_captured === 1,
            linkedMemoryId: row.linked_memory_id,
        };
    }
}
export const userPromptManager = new UserPromptManager();
