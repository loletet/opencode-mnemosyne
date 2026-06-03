import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let distBuildChecked = false;

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function newestSourceMtimeMs(directory: string): number {
  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(path));
      continue;
    }

    if (/\.(ts|js|json|html|css|ico)$/.test(entry.name)) {
      newest = Math.max(newest, mtimeMs(path));
    }
  }

  return newest;
}

function distPluginIsCurrent(): boolean {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const distPluginPath = join(repoRoot, "dist/plugin.js");
  const sourcePath = join(repoRoot, "src");

  return existsSync(distPluginPath) && mtimeMs(distPluginPath) >= newestSourceMtimeMs(sourcePath);
}

export function ensureDistBuilt(): void {
  if (distBuildChecked && distPluginIsCurrent()) return;
  if (distPluginIsCurrent()) {
    distBuildChecked = true;
    return;
  }

  const result = spawnSync("bun", ["run", "build"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build dist before tests (exit ${result.status ?? "unknown"})`);
  }

  distBuildChecked = true;
}
