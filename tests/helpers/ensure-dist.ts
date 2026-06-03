import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distPluginPath = join(repoRoot, "dist", "plugin.js");
const lockPath = join(repoRoot, ".dist-build.lock");

let ensured = false;

function newestMtimeMs(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const childPath = join(path, entry.name);
    newest = Math.max(newest, newestMtimeMs(childPath));
  }

  return newest;
}

function distIsCurrent(): boolean {
  if (!existsSync(distPluginPath)) {
    return false;
  }

  const distMtime = statSync(distPluginPath).mtimeMs;
  const newestSourceMtime = Math.max(
    newestMtimeMs(join(repoRoot, "src")),
    statSync(join(repoRoot, "package.json")).mtimeMs,
    statSync(join(repoRoot, "tsconfig.json")).mtimeMs
  );

  return distMtime >= newestSourceMtime;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireBuildLock(): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      return () => {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 60_000) {
        rmSync(lockPath, { force: true });
        continue;
      }

      sleep(100);
    }
  }
}

export function ensureDistBuild(): void {
  if (ensured || distIsCurrent()) {
    ensured = true;
    return;
  }

  const releaseLock = acquireBuildLock();
  try {
    if (distIsCurrent()) {
      ensured = true;
      return;
    }

    const result = spawnSync("bun", ["run", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, MNEMOSYNE_ENSURE_DIST_BUILD: "1" },
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`Failed to build dist artifacts (exit ${result.status ?? "unknown"})`);
    }

    ensured = true;
  } finally {
    releaseLock();
  }
}
