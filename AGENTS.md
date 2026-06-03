# AGENTS.md

## Local OpenCode plugin loading

Do not configure this repo with the bare npm plugin name:

```jsonc
"opencode-mnemosyne"
```

That npm package name already exists publicly and does not point at this fork. Local development must load the built plugin file directly:

```jsonc
"file:///home/discord/snip/opencode-mnemosyne/dist/plugin.js"
```

Before restarting OpenCode, build the plugin:

```bash
PATH="$HOME/.bun/bin:$PATH" bun install
PATH="$HOME/.bun/bin:$PATH" bun run build
```

The active global OpenCode config is:

```text
/home/codexy/.config/opencode/opencode.jsonc
```

OpenCode loads config only at startup. After changing the plugin path or rebuilding `dist/plugin.js`, restart OpenCode.

If plugin loading crashes OpenCode, start with external plugins disabled:

```bash
opencode --pure
```

Then comment out the local plugin entry and restart normally.

## Verification commands

```bash
PATH="$HOME/.bun/bin:$PATH" bun run typecheck
PATH="$HOME/.bun/bin:$PATH" bun run format:check
PATH="$HOME/.bun/bin:$PATH" bun run test
```
