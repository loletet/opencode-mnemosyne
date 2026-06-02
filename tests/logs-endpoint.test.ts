import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("log endpoint handlers", () => {
  let logDir: string;
  let logFile: string;
  let originalLogFile: string | undefined;
  let originalLogLevel: string | undefined;

  beforeAll(() => {
    logDir = mkdtempSync(join(tmpdir(), "mnemosyne-handler-"));
    logFile = join(logDir, "test.log");
    originalLogFile = process.env.OPENCODE_MNEMOSYNE_LOG_FILE;
    originalLogLevel = process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL;
    process.env.OPENCODE_MNEMOSYNE_LOG_FILE = logFile;
    process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL = "debug";
  });

  afterAll(() => {
    if (originalLogFile === undefined) {
      delete process.env.OPENCODE_MNEMOSYNE_LOG_FILE;
    } else {
      process.env.OPENCODE_MNEMOSYNE_LOG_FILE = originalLogFile;
    }
    if (originalLogLevel === undefined) {
      delete process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL;
    } else {
      process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL = originalLogLevel;
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(logFile, { force: true });
  });

  it("handleGetLogs returns the most recent entries", async () => {
    const { logger, _resetForTests } = await import("../src/services/logger.js");
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    _resetForTests();
    for (let i = 0; i < 5; i++) logger.info("test", `entry-${i}`);
    const result = handleGetLogs({ tail: 3 });
    expect(result.success).toBe(true);
    expect(result.data?.entries.length).toBe(3);
    expect(result.data?.entries.map((e) => e.message)).toEqual([
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
  });

  it("handleGetLogs filters by minLevel", async () => {
    const { logger, _resetForTests } = await import("../src/services/logger.js");
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    _resetForTests();
    logger.debug("test", "should be filtered out");
    logger.info("test", "info entry");
    logger.warn("test", "warn entry");
    logger.error("test", "error entry");
    const result = handleGetLogs({ minLevel: "warn" });
    expect(result.success).toBe(true);
    expect(result.data?.entries.map((e) => e.message)).toEqual([
      "warn entry",
      "error entry",
    ]);
  });

  it("handleGetLogs filters by scope prefix", async () => {
    const { logger, _resetForTests } = await import("../src/services/logger.js");
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    _resetForTests();
    logger.info("auto-capture", "matched");
    logger.info("client", "not matched");
    logger.info("auto-capture.scan", "also matched (prefix)");
    const result = handleGetLogs({ scope: "auto-capture" });
    expect(result.success).toBe(true);
    expect(result.data?.entries.length).toBe(2);
    expect(
      result.data?.entries.every((e) => e.scope.startsWith("auto-capture")),
    ).toBe(true);
  });

  it("handleGetLogs rejects invalid minLevel", async () => {
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    const result = handleGetLogs({ minLevel: "panic" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid minLevel");
  });

  it("handleGetLogs rejects invalid since timestamp", async () => {
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    const result = handleGetLogs({ since: "not-a-date" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid since");
  });

  it("handleGetLogs caps tail at 5000", async () => {
    const { handleGetLogs } = await import("../src/services/api-handlers.js");
    const result = handleGetLogs({ tail: 100000 });
    expect(result.success).toBe(true);
  });

  it("handleGetLogsStream returns a Response with text/event-stream content-type", async () => {
    const { handleGetLogsStream } = await import("../src/services/api-handlers.js");
    const { response } = handleGetLogsStream({ minLevel: "info" });
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-cache");
    // Consume the stream body so the controller doesn't hang.
    await response.body?.cancel();
  });

  it("handleGetLogsStream subscriber receives matching entries", async () => {
    const { logger, subscribe, _resetForTests } = await import("../src/services/logger.js");
    const { handleGetLogsStream } = await import("../src/services/api-handlers.js");
    _resetForTests();

    // Capture only entries that the SSE handler would forward
    // (i.e. minLevel=info, no scope filter), so we can assert that
    // debug entries are NOT streamed even though our test subscriber
    // would otherwise see them.
    const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    const minLevel = LEVEL_RANK["info"] ?? 0;
    const received: string[] = [];
    const unsub = subscribe((e) => {
      if ((LEVEL_RANK[e.level] ?? 0) >= minLevel) {
        received.push(`${e.level}:${e.message}`);
      }
    });

    const { response } = handleGetLogsStream({ minLevel: "info" });
    // Consume the initial "ready" event so the controller enters the active state.
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    const readyPromise = reader.read().then((r) => dec.decode(r.value ?? new Uint8Array()));

    // Wait briefly for "ready" event then emit and unsubscribe.
    await readyPromise;
    logger.debug("test", "should not appear (filtered by minLevel=info)");
    logger.info("test", "hello");
    logger.error("test", "boom");
    await new Promise((r) => setTimeout(r, 50));
    unsub();
    await reader.cancel();

    expect(received).toContain("info:hello");
    expect(received).toContain("error:boom");
    expect(received.find((r) => r.startsWith("debug:"))).toBeUndefined();
  });
});
