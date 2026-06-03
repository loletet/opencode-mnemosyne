/**
 * Mnemosyne logger.
 *
 * Output format (on disk):
 *
 *     [2026-06-02T17:42:11.331Z] ERROR [compaction.handler] compaction failed
 *       level: error
 *       scope: compaction.handler
 *       sessionID: ses_abc123
 *       error:
 *         name: TypeError
 *         message: Cannot read properties of undefined (reading 'foo')
 *         stack: |
 *           at CompactionHandler.run (compaction.ts:123:5)
 *           at processTicksAndRejections (node:internal/process/task_queues:95:5)
 *         cause:
 *           name: Error
 *           message: upstream returned 500
 *
 *     [2026-06-02T17:42:11.402Z] INFO [auto-capture] started
 *       level: info
 *       scope: auto-capture
 *       sessionID: ses_abc123
 *
 * Designed so that:
 *   - `tail -f <log>` is human-readable
 *   - `tail -f <log> | grep -E '^\[[^]]*\] (ERROR|WARN)'` filters by level
 *   - `tail -f <log> | sed -n '/^$/,$p'` extracts just the data block
 *   - `/api/logs` returns the same entries as NDJSON
 *   - `/api/logs/stream` (SSE) emits one `data: <json>\n\n` per new entry
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
/**
 * Per-call structured context. Propagated via AsyncLocalStorage so any
 * logger call inside a `runWithContext` callback gets the context
 * automatically — no need to thread sessionID through every function.
 */
export interface LogContext {
    sessionID?: string;
    agentID?: string;
    scope?: string;
    [key: string]: unknown;
}
export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    scope: string;
    message: string;
    context: LogContext;
    error?: SerializedError;
}
export interface SerializedError {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
}
/** Subscriber callback receives each entry as it is emitted. */
export type LogSubscriber = (entry: LogEntry) => void;
/**
 * Run `fn` with the given structured context attached. Any `logger.*`
 * call inside `fn` (or anything it calls synchronously) will pick up
 * the context automatically. Context composes: nested calls merge
 * keys, with the innermost winning.
 */
export declare function runWithContext<T>(ctx: LogContext, fn: () => T): T;
export declare function serializeError(err: unknown): SerializedError;
export declare const logger: {
    readonly debug: (scope: string, message: string, extra?: LogContext) => void;
    readonly info: (scope: string, message: string, extra?: LogContext) => void;
    readonly warn: (scope: string, message: string, error?: unknown, extra?: LogContext) => void;
    readonly error: (scope: string, message: string, error?: unknown, extra?: LogContext) => void;
};
/**
 * Backwards-compatible export used by the existing 80+ call sites:
 *   log("Some message", { key: value });
 * Routes to `logger.info` with scope "app" unless the caller passes a
 * scope via the optional 3rd argument. If the data object contains an
 * `error` key that is already an Error instance, the full chain is
 * serialized; otherwise it is included as a regular context field.
 *
 * @deprecated Prefer `logger.info(scope, message, extra)` for new code.
 */
export declare function log(message: string, data?: unknown, scope?: string): void;
/**
 * Read the last `n` lines from the log file. Returns parsed LogEntry
 * objects. Lines that don't parse as Mnemosyne log entries (e.g. the
 * "--- Session started ---" markers) are returned as synthetic entries
 * with `level: "info"` and the raw text in `message`.
 */
export declare function readLastEntries(n: number): LogEntry[];
/**
 * Parse the on-disk text into structured entries. Entries are
 * delimited by lines that match the Mnemosyne header pattern
 * (starting with `[ISO] LEVEL [scope]`). Lines that don't match the
 * header pattern and aren't indented are treated as synthetic info
 * entries (e.g. the "--- Session started ---" markers).
 */
export declare function parseEntries(text: string): LogEntry[];
/**
 * Subscribe to in-process log emissions. Returns an unsubscribe function.
 * Used by the SSE stream and by tests.
 */
export declare function subscribe(fn: LogSubscriber): () => void;
/**
 * Return the current log file path. Useful for the /api/logs endpoint
 * and for tests.
 */
export declare function getLogPath(): string;
export declare function _resetForTests(): void;
//# sourceMappingURL=logger.d.ts.map