import type { PluginModule } from "@opencode-ai/plugin";
import pkg from "../package.json" with { type: "json" };
const { MnemosynePlugin } = await import("./index.js");

export const id =
  typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "opencode-mnemosyne";
export { MnemosynePlugin };
export default { id, server: MnemosynePlugin } satisfies PluginModule;
