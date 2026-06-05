import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("logger v2", () => {
  let logFile: string;
  let logDir: string;

  beforeAll(() => {
    logDir = mkdtempSync(join(tmpdir(), "mnemosyne-logger-"));
    logFile = join(logDir, "test.log");
    process.env.OPENCODE_MNEMOSYNE_LOG_FILE = logFile;
    process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL = "debug";
  });

  afterAll(() => {
    delete process.env.OPENCODE_MNEMOSYNE_LOG_FILE;
    delete process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL;
    rmSync(logDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(logFile, { force: true });
  });

  it("writes a header line plus indented context fields", async () => {
    const { logger, _resetForTests, _internal } = await import("../src/services/logger.js");
    _resetForTests();
    logger.info("test.scope", "hello world", { foo: "bar", n: 42 });
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).toMatch(
      /INFO\s+20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[test\.scope\] hello world/
    );
    expect(text).toMatch(/foo=bar/);
    expect(text).toMatch(/n=42/);
  });

  it("serializes Error with full chain (name, message, stack, cause)", async () => {
    const { logger, _resetForTests, _internal } = await import("../src/services/logger.js");
    _resetForTests();
    const root = new Error("upstream returned 500");
    const wrapped = new TypeError("outer failure");
    (wrapped as Error & { cause?: unknown }).cause = root;
    logger.error("test.scope", "wrapped failure", wrapped);
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).toMatch(/ERROR\s+20\d\d-.* \[test\.scope\] wrapped failure/);
    expect(text).toMatch(/  error:/);
    expect(text).toMatch(/"name": "TypeError"/);
    expect(text).toMatch(/"message": "outer failure"/);
    expect(text).toMatch(/"stack":/);
    expect(text).toMatch(/"cause":/);
    expect(text).toMatch(/"name": "Error"/);
    expect(text).toMatch(/"message": "upstream returned 500"/);
  });

  it("respects log level threshold (env var)", async () => {
    process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL = "warn";
    const { logger, _resetForTests, _internal } = await import("../src/services/logger.js");
    _resetForTests();
    logger.debug("test.scope", "should not appear");
    logger.info("test.scope", "should not appear either");
    logger.warn("test.scope", "should appear");
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).not.toContain("should not appear");
    expect(text).toContain("WARN");
    expect(text).toContain("should appear");
    process.env.OPENCODE_MNEMOSYNE_LOG_LEVEL = "debug";
  });

  it("propagates context through runWithContext", async () => {
    const { logger, runWithContext, _resetForTests, _internal } =
      await import("../src/services/logger.js");
    _resetForTests();
    runWithContext({ sessionID: "ses_abc" }, () => {
      logger.info("test.scope", "with session");
      runWithContext({ agentID: "choom" }, () => {
        logger.info("test.scope", "nested");
      });
      logger.info("test.scope", "still has session");
    });
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).toMatch(/sessionID=ses_abc/);
    expect(text).toMatch(/agentID=choom/);
  });

  it("subscribers receive each entry in-process", async () => {
    const { logger, subscribe, _resetForTests } = await import("../src/services/logger.js");
    _resetForTests();
    const received: string[] = [];
    const unsub = subscribe((e) => received.push(e.message));
    logger.info("test.scope", "first");
    logger.warn("test.scope", "second");
    unsub();
    logger.info("test.scope", "after unsub");
    expect(received).toEqual(["first", "second"]);
  });

  it("the legacy log() export still works and routes to info", async () => {
    const { log, _resetForTests, _internal } = await import("../src/services/logger.js");
    _resetForTests();
    log("legacy message", { key: "value" });
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).toMatch(/INFO\s+20\d\d-.* \[app\] legacy message/);
    expect(text).toMatch(/key=value/);
  });

  it("legacy log() detects an Error in the data object and serializes the chain", async () => {
    const { log, _resetForTests, _internal } = await import("../src/services/logger.js");
    _resetForTests();
    const err = new Error("real error");
    log("legacy error", { error: err, context: "extra" });
    const text = _internal.stripAnsi(readFileSync(logFile, "utf-8"));
    expect(text).toMatch(/  error:/);
    expect(text).toMatch(/"name": "Error"/);
    expect(text).toMatch(/"message": "real error"/);
    expect(text).toMatch(/context=extra/);
  });

  it("parseEntries round-trips the on-disk format", async () => {
    const { logger, parseEntries, _resetForTests } = await import("../src/services/logger.js");
    _resetForTests();
    logger.info("rt", "alpha", { x: 1 });
    logger.error("rt", "bravo", new Error("boom"));
    const text = readFileSync(logFile, "utf-8");
    const entries = parseEntries(text);
    // The session-start marker is captured as a synthetic "system" entry;
    // our two real entries follow it.
    const real = entries.filter((e) => e.scope !== "system");
    expect(real.length).toBe(2);
    expect(real[0]?.message).toBe("alpha");
    expect(real[0]?.context.x).toBe(1);
    expect(real[1]?.message).toBe("bravo");
    expect(real[1]?.error?.message).toBe("boom");
  });

  it("readLastEntries returns the most recent N entries in order", async () => {
    const { logger, readLastEntries, _resetForTests } = await import("../src/services/logger.js");
    _resetForTests();
    for (let i = 0; i < 5; i++) {
      logger.info("rt", `entry-${i}`);
    }
    const last3 = readLastEntries(3);
    expect(last3.map((e) => e.message)).toEqual(["entry-2", "entry-3", "entry-4"]);
  });
});
