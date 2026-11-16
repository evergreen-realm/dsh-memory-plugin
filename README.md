# DSH Memory Plugin

DeepSeek Harness [Cordis](https://cordis.moe/) bundle providing **shared memory** across sessions via [EverOS](https://everos.dev) and [GBrain](https://gbrain.dev) backends.

## Architecture

```
packages/
├── memory-core/     # Retrieval engine, corpus bridge, KAG-lite search
│                    # Pure Node.js built-ins — zero npm dependencies
└── dsh-memory/      # DSH Cordis bundle that registers tools + web providers
                     # Imports memory-core at build time (bundled into dist/core/)
```

## Prerequisites

- **Node.js ≥ 22.6.0** (uses native `stripTypeScriptTypes`)
- **DeepSeek Harness ≥ 0.2.0**
- No npm packages required — zero external dependencies

## Build

```bash
git clone https://github.com/evergreen-realm/dsh-memory-plugin.git
cd dsh-memory-plugin
node scripts/build-dist.mjs
```

This transpiles TypeScript → JavaScript using Node's native type stripping and bundles `memory-core` into `dsh-memory/dist/core/` for a self-contained runtime.

## Test

```bash
node --test packages/memory-core/test/*.test.ts packages/dsh-memory/test/*.test.ts
```

## Install into DeepSeek Harness

### Option A: Manual

```powershell
# 1. Copy built plugin to DSH profile
$target = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@evergreen-realm\dsh-memory-plugin"
New-Item -ItemType Directory -Force -Path $target
Copy-Item -Recurse packages\dsh-memory\dist $target\dist
Copy-Item -Recurse packages\dsh-memory\src $target\src
Copy-Item packages\dsh-memory\package.json $target\
Copy-Item packages\dsh-memory\tsconfig.json $target\
Copy-Item packages\dsh-memory\cordis.patch.yml $target\

# 2. Add to profile bundles (edit ~/.dsh/profiles/desktop/package.json)
# Add "@evergreen-realm/dsh-memory-plugin" to dsh.profile.bundles array

# 3. Restart DeepSeek Harness
```

### Option B: Automated (recommended)

Use the [dsh-harness-setup](https://github.com/evergreen-realm/dsh-harness-setup) repo for one-command installation.

## What It Does

- **EverOS Bridge**: Connects to local EverOS instance for persistent memory storage
- **GBrain Bridge**: Graph-based knowledge retrieval with entity/relation extraction
- **KAG-Lite Search**: Lightweight knowledge-augmented generation search
- **Corpus Bridge**: Bridges session history into searchable memory corpus
- **Workspace Context**: Captures and injects project context into conversations
- **Preflight Checks**: Validates backend connectivity on startup
- **Secret Redaction**: Automatically redacts sensitive data before storage

## License

MIT
