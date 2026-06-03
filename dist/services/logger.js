import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const LEVEL_RANK = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const LEVEL_LABEL = {
    debug: "DEBUG",
    info: "INFO",
    warn: "WARN",
    error: "ERROR",
};
const DEFAULT_MIN_LEVEL = "info";
const GLOBAL_LOGGER_KEY = Symbol.for("opencode-mnemosyne.logger.initialized");
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const SUBSCRIBER_KEY = Symbol.for("opencode-mnemosyne.logger.subscribers");
// ---------------------------------------------------------------------------
// Path / file rotation
// ---------------------------------------------------------------------------
function getLogFilePath() {
    return (process.env.OPENCODE_MNEMOSYNE_LOG_FILE ??
        join(homedir(), ".opencode-mnemosyne", "opencode-mnemosyne.log"));
}
function getLogDirPath() {
    const logFile = getLogFilePath();
    const lastSlash = Math.max(logFile.lastIndexOf("/"), logFile.lastIndexOf("\\"));
    return lastSlash === -1 ? "." : logFile.slice(0, lastSlash);
}
function rotateLog() {
    const logFile = getLogFilePath();
    if (!existsSync(logFile))
        return;
    const stats = statSync(logFile);
    if (stats.size < MAX_LOG_SIZE)
        return;
    const oldLog = logFile + ".old";
    if (existsSync(oldLog))
        unlinkSync(oldLog);
    renameSync(logFile, oldLog);
}
function ensureLoggerInitialized() {
    if (globalThis[GLOBAL_LOGGER_KEY])
        return;
    const logDir = getLogDirPath();
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    rotateLog();
    writeFileSync(getLogFilePath(), `\n--- Session started: ${new Date().toISOString()} ---\n\n`, {
        flag: "a",
    });
    globalThis[GLOBAL_LOGGER_KEY] = true;
}
class ContextStore {
    store = undefined;
    listeners = [];
    get() {
        return this.store;
    }
    run(ctx, fn) {
        const previous = this.store;
        const next = {
            ctx: { ...(previous?.ctx ?? {}), ...ctx },
        };
        this.store = next;
        this.notify();
        try {
            return fn();
        }
        finally {
            this.store = previous;
            this.notify();
        }
    }
    notify() {
        for (const l of this.listeners)
            l(this.store);
    }
}
const _ctx = new ContextStore();
/**
 * Run `fn` with the given structured context attached. Any `logger.*`
 * call inside `fn` (or anything it calls synchronously) will pick up
 * the context automatically. Context composes: nested calls merge
 * keys, with the innermost winning.
 */
export function runWithContext(ctx, fn) {
    return _ctx.run(ctx, fn);
}
function currentContext() {
    return _ctx.get()?.ctx ?? {};
}
// ---------------------------------------------------------------------------
// Error serialization (preserves the .cause chain)
// ---------------------------------------------------------------------------
export function serializeError(err) {
    if (err === null || err === undefined) {
        return { name: "NonError", message: String(err) };
    }
    if (typeof err === "string") {
        return { name: "StringThrown", message: err };
    }
    if (typeof err !== "object") {
        return { name: "NonError", message: String(err) };
    }
    // Best-effort: anything with a .message is treated as an Error-like.
    const e = err;
    const serialized = {
        name: e.name ?? "Error",
        message: e.message ?? String(err),
    };
    // The stack is compressed to a single line so the on-disk format
    // stays greppable (newlines in the middle of a value break the
    // parser). The full multi-line stack is available via the API.
    if (typeof e.stack === "string") {
        serialized.stack = e.stack.replace(/\n\s+/g, " | ").replace(/\n/g, " | ");
    }
    if (e.cause !== undefined && e.cause !== err) {
        serialized.cause = serializeError(e.cause);
    }
    return serialized;
}
// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function formatValue(v, indent) {
    if (v === null || v === undefined)
        return String(v);
    if (typeof v === "string") {
        // Multi-line strings get indented continuation
        if (v.includes("\n")) {
            return ("|\n" +
                v
                    .split("\n")
                    .map((line) => indent + "  " + line)
                    .join("\n"));
        }
        return v;
    }
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    if (Array.isArray(v)) {
        if (v.length === 0)
            return "[]";
        return v.map((item) => "\n" + indent + "  - " + formatValue(item, indent + "  ")).join("");
    }
    if (typeof v === "object") {
        const obj = v;
        const keys = Object.keys(obj);
        if (keys.length === 0)
            return "{}";
        return keys
            .map((k) => "\n" + indent + "  " + k + ": " + formatValue(obj[k], indent + "  "))
            .join("");
    }
    return String(v);
}
function formatEntry(entry) {
    const colors = Boolean(process.stdout?.isTTY && !process.env.NO_COLOR);
    const levelText = paint(LEVEL_LABEL[entry.level].padEnd(5), LEVEL_COLOR[entry.level], colors);
    const timeText = paint(entry.timestamp, ANSI.white, colors);
    const scopeText = paint(entry.scope, ANSI.cyan, colors);
    const messageText = paint(entry.message, ANSI.bold, colors);
    const inline = [];
    const multiline = [];
    for (const [key, value] of Object.entries(entry.context ?? {})) {
        if (isEmpty(value))
            continue;
        const inlineValue = formatInlineValue(value);
        if (inlineValue === null) {
            multiline.push([key, value]);
        }
        else {
            inline.push(`${paint(key, ANSI.gray, colors)}=${paint(inlineValue, ANSI.magenta, colors)}`);
        }
    }
    if (entry.error) {
        multiline.push(["error", entry.error]);
    }
    const header = [levelText, timeText, `[${scopeText}]`, messageText, ...inline].join(" ");
    const lines = [header];
    for (const [key, value] of multiline) {
        lines.push(`  ${paint(key, ANSI.gray, colors)}:`);
        lines.push(indent(formatBlockValue(value), 4));
    }
    return lines.join("\n");
}
const ANSI = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    gray: "\x1b[90m",
    white: "\x1b[97m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
};
const LEVEL_COLOR = {
    debug: ANSI.cyan,
    info: ANSI.green,
    warn: ANSI.yellow,
    error: ANSI.red,
};
function paint(text, color, enabled) {
    return enabled ? color + text + ANSI.reset : text;
}
function isEmpty(value) {
    return value === undefined || value === null || value === "";
}
function isSimple(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function formatInlineValue(value) {
    if (Array.isArray(value)) {
        return value.every(isSimple) ? value.join(",") : null;
    }
    if (isSimple(value)) {
        const text = String(value);
        return text.includes("\n") ? null : text;
    }
    return null;
}
function formatBlockValue(value) {
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value, null, 2);
}
function indent(text, spaces = 4) {
    const pad = " ".repeat(spaces);
    return String(text)
        .split("\n")
        .map((line) => pad + line)
        .join("\n");
}
// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------
function emit(level, scope, message, error, extra) {
    const minLevel = process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL ?? DEFAULT_MIN_LEVEL;
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel])
        return;
    const merged = { ...currentContext(), ...(extra ?? {}) };
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        scope: scope || merged.scope || "app",
        message,
        context: merged,
    };
    if (error !== undefined) {
        entry.error = serializeError(error);
    }
    ensureLoggerInitialized();
    try {
        appendFileSync(getLogFilePath(), formatEntry(entry) + "\n");
    }
    catch {
        // If the log file is unwritable (disk full, permissions, etc.) we silently
        // drop the entry. Logging must never crash the host process.
    }
    // Notify in-process subscribers (SSE stream, test spies).
    const subs = globalThis[SUBSCRIBER_KEY];
    if (subs) {
        for (const s of subs) {
            try {
                s(entry);
            }
            catch {
                // Subscriber bugs must not break the emitter.
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const logger = {
    debug(scope, message, extra) {
        emit("debug", scope, message, undefined, extra);
    },
    info(scope, message, extra) {
        emit("info", scope, message, undefined, extra);
    },
    warn(scope, message, error, extra) {
        emit("warn", scope, message, error, extra);
    },
    error(scope, message, error, extra) {
        emit("error", scope, message, error, extra);
    },
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
export function log(message, data, scope) {
    const extra = {};
    let error = undefined;
    if (data && typeof data === "object" && !Array.isArray(data)) {
        const obj = data;
        if (obj.error instanceof Error) {
            error = obj.error;
            const { error: _e, ...rest } = obj;
            Object.assign(extra, rest);
        }
        else {
            Object.assign(extra, obj);
        }
    }
    else if (data !== undefined) {
        extra.data = data;
    }
    emit("info", scope ?? "app", message, error, extra);
}
// ---------------------------------------------------------------------------
// Reader helpers (for /api/logs and tests)
// ---------------------------------------------------------------------------
/**
 * Read the last `n` lines from the log file. Returns parsed LogEntry
 * objects. Lines that don't parse as Mnemosyne log entries (e.g. the
 * "--- Session started ---" markers) are returned as synthetic entries
 * with `level: "info"` and the raw text in `message`.
 */
export function readLastEntries(n) {
    ensureLoggerInitialized();
    const path = getLogFilePath();
    if (!existsSync(path))
        return [];
    const text = readFileSyncSafely(path);
    return parseEntries(text).slice(-n);
}
function readFileSyncSafely(path) {
    try {
        return readFileSync(path, "utf-8");
    }
    catch {
        return "";
    }
}
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const OLD_HEADER_RE = /^\[([^\]]+)\] (DEBUG|INFO|WARN|ERROR) \[([^\]]+)\] (.*)$/;
const PRETTY_HEADER_RE = /^(DEBUG|INFO|WARN|ERROR)\s+(\S+)\s+\[([^\]]+)\]\s+(.*)$/;
/**
 * Parse the on-disk text into structured entries. Entries are
 * delimited by lines that match the Mnemosyne header pattern
 * (starting with `[ISO] LEVEL [scope]`). Lines that don't match the
 * header pattern and aren't indented are treated as synthetic info
 * entries (e.g. the "--- Session started ---" markers).
 */
export function parseEntries(text) {
    const lines = text.split("\n");
    const entries = [];
    let current = null;
    const flush = () => {
        if (!current)
            return;
        const parsed = parseHeader(current.header);
        if (!parsed) {
            entries.push({
                timestamp: new Date(0).toISOString(),
                level: "info",
                scope: "system",
                message: current.header,
                context: {},
            });
        }
        else {
            const { timestamp, level, scope, message } = parsed;
            const context = { ...parsed.context };
            let error;
            let i = 0;
            while (i < current.body.length) {
                const line = current.body[i];
                if (line === undefined) {
                    i++;
                    continue;
                }
                const cleanLine = stripAnsi(line);
                const colonIdx = cleanLine.indexOf(":");
                if (colonIdx === -1) {
                    i++;
                    continue;
                }
                const key = cleanLine.slice(0, colonIdx).trim();
                let valueText = cleanLine.slice(colonIdx + 1).trim();
                // Continuation: next line is deeper-indented than this one
                // (top-level context fields are at 2 spaces; sub-fields of
                // an object/array value or of an error block are at 4+).
                // The value text is passed verbatim to the sub-parser
                // (e.g. parseErrorBlock) which handles its own indent.
                const currentIndent = cleanLine.length - cleanLine.trimStart().length;
                while (i + 1 < current.body.length) {
                    const next = stripAnsi(current.body[i + 1] ?? "");
                    const nextIndent = next.length - next.trimStart().length;
                    if (nextIndent > currentIndent) {
                        valueText += "\n" + next;
                        i++;
                    }
                    else {
                        break;
                    }
                }
                if (key === "error") {
                    error = parseErrorBlock(valueText);
                }
                else if (valueText === "true" || valueText === "false") {
                    context[key] = valueText === "true";
                }
                else if (/^-?\d+(\.\d+)?$/.test(valueText)) {
                    context[key] = Number(valueText);
                }
                else {
                    context[key] = valueText;
                }
                i++;
            }
            const entry = {
                timestamp,
                level,
                scope,
                message,
                context,
            };
            if (error)
                entry.error = error;
            entries.push(entry);
        }
        current = null;
    };
    for (const line of lines) {
        if (parseHeader(line)) {
            flush();
            current = { header: line, body: [] };
        }
        else if (current) {
            current.body.push(line);
        }
        else if (line.trim().length > 0) {
            // Standalone non-header line (e.g. session marker). Capture as its own entry.
            entries.push({
                timestamp: new Date(0).toISOString(),
                level: "info",
                scope: "system",
                message: line,
                context: {},
            });
        }
    }
    flush();
    return entries;
}
function stripAnsi(text) {
    return text.replace(ANSI_RE, "");
}
function parseHeader(header) {
    const clean = stripAnsi(header);
    const old = OLD_HEADER_RE.exec(clean);
    if (old) {
        return {
            timestamp: old[1] ?? new Date().toISOString(),
            level: (old[2] ?? "INFO").toLowerCase(),
            scope: old[3] ?? "app",
            message: old[4] ?? "",
            context: {},
        };
    }
    const pretty = PRETTY_HEADER_RE.exec(clean);
    if (!pretty)
        return null;
    const level = (pretty[1] ?? "INFO").toLowerCase();
    const timestamp = pretty[2] ?? new Date().toISOString();
    const scope = pretty[3] ?? "app";
    const { message, context } = parsePrettyMessageAndInlineContext(pretty[4] ?? "");
    return { timestamp, level, scope, message, context };
}
function parsePrettyMessageAndInlineContext(text) {
    const parts = text.split(" ");
    const context = {};
    while (parts.length > 0) {
        const last = parts[parts.length - 1] ?? "";
        const match = /^([A-Za-z_][\w.-]*)=(.*)$/.exec(last);
        if (!match)
            break;
        parts.pop();
        context[match[1] ?? ""] = parseScalar(match[2] ?? "");
    }
    return { message: parts.join(" "), context };
}
function parseScalar(valueText) {
    if (valueText === "true" || valueText === "false")
        return valueText === "true";
    if (/^-?\d+(\.\d+)?$/.test(valueText))
        return Number(valueText);
    return valueText;
}
function parseErrorBlock(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed);
        return parsed;
    }
    // The error block is formatted with sub-fields at 4-space indent
    // and serialized errors are flat (no multi-line values, since
    // stacks are compressed to a single line in serializeError). Strip
    // up to 4 leading spaces from each line and parse as "key: value".
    const lines = text.split("\n");
    const err = { name: "Error", message: "" };
    for (const raw of lines) {
        const stripped = raw.replace(/^ {0,4}/, "");
        const m = /^(\w+):\s*(.*)$/.exec(stripped);
        if (!m)
            continue;
        const key = m[1] ?? "";
        const val = m[2] ?? "";
        if (key === "name")
            err.name = val;
        else if (key === "message")
            err.message = val;
        else if (key === "stack")
            err.stack = val;
        else if (key === "cause") {
            // Nested cause: serializeError uses "name | message" form on
            // a single line, so split it back into a SerializedError.
            const causeMatch = /^([^|]+?)\s*\|\s*(.*)$/.exec(val);
            if (causeMatch) {
                err.cause = {
                    name: causeMatch[1]?.trim() ?? "Error",
                    message: causeMatch[2]?.trim() ?? "",
                };
            }
            else {
                err.cause = { name: "Error", message: val };
            }
        }
    }
    return err;
}
/**
 * Subscribe to in-process log emissions. Returns an unsubscribe function.
 * Used by the SSE stream and by tests.
 */
export function subscribe(fn) {
    ensureLoggerInitialized();
    let subs = globalThis[SUBSCRIBER_KEY];
    if (!subs) {
        subs = new Set();
        globalThis[SUBSCRIBER_KEY] = subs;
    }
    subs.add(fn);
    return () => {
        subs?.delete(fn);
    };
}
/**
 * Return the current log file path. Useful for the /api/logs endpoint
 * and for tests.
 */
export function getLogPath() {
    return getLogFilePath();
}
// Test/utility: reset logger state (used by the test suite).
export function _resetForTests() {
    globalThis[GLOBAL_LOGGER_KEY] = false;
    globalThis[SUBSCRIBER_KEY] = undefined;
}
