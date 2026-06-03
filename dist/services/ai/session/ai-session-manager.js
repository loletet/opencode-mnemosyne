import { getDatabase } from "../../sqlite/sqlite-bootstrap.js";
import { join } from "node:path";
import { connectionManager } from "../../sqlite/connection-manager.js";
import { CONFIG } from "../../../config.js";
const Database = getDatabase();
const AI_SESSIONS_DB_NAME = "ai-sessions.db";
export class AISessionManager {
    db;
    dbPath;
    sessionRetentionMs;
    constructor() {
        this.dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
        this.db = connectionManager.getConnection(this.dbPath);
        this.sessionRetentionMs = CONFIG.aiSessionRetentionDays * 24 * 60 * 60 * 1000;
        this.initDatabase();
    }
    initDatabase() {
        this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
        this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)");
        this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ai_session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        content_blocks TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (ai_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
      )
    `);
        this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)");
        this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)");
    }
    getSession(sessionId, provider) {
        const stmt = this.db.prepare(`
      SELECT * FROM ai_sessions 
      WHERE session_id = ? AND provider = ? AND expires_at > ?
    `);
        const row = stmt.get(sessionId, provider, Date.now());
        if (!row)
            return null;
        return this.rowToSession(row);
    }
    createSession(params) {
        const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const now = Date.now();
        const expiresAt = now + this.sessionRetentionMs;
        this.db.run(`
      INSERT INTO ai_sessions (
        id, provider, session_id, conversation_id, 
        metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            id,
            params.provider,
            params.sessionId,
            params.conversationId || null,
            JSON.stringify(params.metadata || {}),
            now,
            now,
            expiresAt,
        ]);
        return this.getSession(params.sessionId, params.provider);
    }
    updateSession(sessionId, provider, updates) {
        const fields = [];
        const values = [];
        if (updates.conversationId !== undefined) {
            fields.push("conversation_id = ?");
            values.push(updates.conversationId);
        }
        if (updates.metadata !== undefined) {
            fields.push("metadata = ?");
            values.push(JSON.stringify(updates.metadata));
        }
        fields.push("updated_at = ?");
        values.push(Date.now());
        values.push(sessionId);
        values.push(provider);
        this.db.run(`
      UPDATE ai_sessions 
      SET ${fields.join(", ")}
      WHERE session_id = ? AND provider = ?
    `, values);
    }
    cleanupExpiredSessions() {
        const result = this.db.run(`DELETE FROM ai_sessions WHERE expires_at < ?`, [Date.now()]);
        return result.changes;
    }
    deleteSession(sessionId, provider) {
        this.db.run(`DELETE FROM ai_sessions WHERE session_id = ? AND provider = ?`, [
            sessionId,
            provider,
        ]);
    }
    addMessage(message) {
        this.db.run(`INSERT INTO ai_messages (
        ai_session_id, sequence, role, content, 
        tool_calls, tool_call_id, content_blocks, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            message.aiSessionId,
            message.sequence,
            message.role,
            message.content,
            message.toolCalls ? JSON.stringify(message.toolCalls) : null,
            message.toolCallId || null,
            message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
            Date.now(),
        ]);
    }
    getMessages(aiSessionId) {
        const stmt = this.db.prepare("SELECT * FROM ai_messages WHERE ai_session_id = ? ORDER BY sequence ASC");
        const rows = stmt.all(aiSessionId);
        return rows.map(this.rowToMessage);
    }
    getLastSequence(aiSessionId) {
        const stmt = this.db.prepare("SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = ?");
        const row = stmt.get(aiSessionId);
        return row?.max_seq ?? -1;
    }
    clearMessages(aiSessionId) {
        this.db.run("DELETE FROM ai_messages WHERE ai_session_id = ?", [aiSessionId]);
    }
    rowToSession(row) {
        return {
            id: row.id,
            provider: row.provider,
            sessionId: row.session_id,
            conversationId: row.conversation_id,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: row.expires_at,
        };
    }
    rowToMessage(row) {
        return {
            id: row.id,
            aiSessionId: row.ai_session_id,
            sequence: row.sequence,
            role: row.role,
            content: row.content,
            toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
            toolCallId: row.tool_call_id,
            contentBlocks: row.content_blocks ? JSON.parse(row.content_blocks) : undefined,
            createdAt: row.created_at,
        };
    }
}
export const aiSessionManager = new AISessionManager();
