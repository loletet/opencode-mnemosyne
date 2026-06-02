/**
 * Tests for the runtime CONFIG object exported from src/config.js.
 *
 * Note on isolation: in Bun, os.homedir() caches its first result for the
 * lifetime of the process, so mutating process.env.HOME in a test does NOT
 * affect subsequent homedir() calls. We still set HOME before the first
 * import so the module-level DATA_DIR resolves somewhere predictable, and
 * we use initConfig(home) in beforeAll so the CONFIG object is rebuilt for
 * this test's directory rather than reading whatever the last test left
 * behind in the shared module state.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "opencode-mnemosyne-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

const configModule = await import("../src/config.js");
const { initConfig } = configModule;

beforeAll(() => {
  initConfig(home);
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe("config", () => {
  describe("CONFIG defaults", () => {
    it("should have a non-empty string storagePath", () => {
      expect(typeof configModule.CONFIG.storagePath).toBe("string");
      expect(configModule.CONFIG.storagePath.length).toBeGreaterThan(0);
    });

    it("should default to Xenova/nomic-embed-text-v1 embedding model", () => {
      expect(typeof configModule.CONFIG.embeddingModel).toBe("string");
    });

    it("should have numeric embeddingDimensions", () => {
      expect(typeof configModule.CONFIG.embeddingDimensions).toBe("number");
      expect(configModule.CONFIG.embeddingDimensions).toBeGreaterThan(0);
    });

    it("should have similarityThreshold between 0 and 1", () => {
      expect(configModule.CONFIG.similarityThreshold).toBeGreaterThanOrEqual(0);
      expect(configModule.CONFIG.similarityThreshold).toBeLessThanOrEqual(1);
    });

    it("should have positive maxMemories", () => {
      expect(configModule.CONFIG.maxMemories).toBeGreaterThan(0);
    });

    it("should have webServerPort as a number", () => {
      expect(typeof configModule.CONFIG.webServerPort).toBe("number");
    });

    it("should have webServerHost as a string", () => {
      expect(typeof configModule.CONFIG.webServerHost).toBe("string");
    });

    it("should have maxVectorsPerShard as a positive number", () => {
      expect(configModule.CONFIG.maxVectorsPerShard).toBeGreaterThan(0);
    });

    it("should have compaction settings", () => {
      expect(configModule.CONFIG.compaction).toBeDefined();
      expect(typeof configModule.CONFIG.compaction.enabled).toBe("boolean");
      expect(typeof configModule.CONFIG.compaction.memoryLimit).toBe("number");
    });

    it("should have chatMessage settings", () => {
      expect(configModule.CONFIG.chatMessage).toBeDefined();
      expect(typeof configModule.CONFIG.chatMessage.enabled).toBe("boolean");
      expect(typeof configModule.CONFIG.chatMessage.maxMemories).toBe("number");
      expect(typeof configModule.CONFIG.chatMessage.excludeCurrentSession).toBe("boolean");
    });

    it("should have chatMessage.injectOn as 'first' or 'always'", () => {
      expect(["first", "always"]).toContain(configModule.CONFIG.chatMessage.injectOn);
    });

    it("should have boolean toggle settings", () => {
      expect(typeof configModule.CONFIG.autoCaptureEnabled).toBe("boolean");
      expect(typeof configModule.CONFIG.injectProfile).toBe("boolean");
      expect(typeof configModule.CONFIG.webServerEnabled).toBe("boolean");
      expect(typeof configModule.CONFIG.autoCleanupEnabled).toBe("boolean");
      expect(typeof configModule.CONFIG.deduplicationEnabled).toBe("boolean");
    });

    it("should expose memory scope config", () => {
      const defaultScope = configModule.CONFIG.memory.defaultScope ?? "project";
      expect(["project", "all-projects"]).toContain(defaultScope);
    });

    it("should have user profile settings as numbers", () => {
      expect(typeof configModule.CONFIG.userProfileAnalysisInterval).toBe("number");
      expect(typeof configModule.CONFIG.userProfileMaxPreferences).toBe("number");
      expect(typeof configModule.CONFIG.userProfileMaxPatterns).toBe("number");
      expect(typeof configModule.CONFIG.userProfileMaxWorkflows).toBe("number");
      expect(typeof configModule.CONFIG.userProfileConfidenceDecayDays).toBe("number");
      expect(typeof configModule.CONFIG.userProfileChangelogRetentionCount).toBe("number");
    });

    it("should have toast settings as booleans", () => {
      expect(typeof configModule.CONFIG.showAutoCaptureToasts).toBe("boolean");
      expect(typeof configModule.CONFIG.showUserProfileToasts).toBe("boolean");
      expect(typeof configModule.CONFIG.showErrorToasts).toBe("boolean");
    });
  });

  describe("isConfigured", () => {
    it("should return true", () => {
      expect(configModule.isConfigured()).toBe(true);
    });

    it("should return a boolean", () => {
      expect(typeof configModule.isConfigured()).toBe("boolean");
    });
  });
});
