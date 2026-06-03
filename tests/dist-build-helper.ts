import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distPluginPath = resolve(repoRoot, "dist", "plugin.js");
const sourcePluginPath = resolve(repoRoot, "src", "plugin.ts");
const packageJsonPath = resolve(repoRoot, "package.json");

function mtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

function isDistPluginFresh(): boolean {
  if (!existsSync(distPluginPath)) return false;

  const distMtime = mtimeMs(distPluginPath);
  return distMtime >= mtimeMs(sourcePluginPath) && distMtime >= mtimeMs(packageJsonPath);
}

export function ensureDistPluginBuilt(): void {
  if (isDistPluginFresh()) return;

  execFileSync("bun", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
