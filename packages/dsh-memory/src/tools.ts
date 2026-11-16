/** Native DSH Cordis Bridge Tools (OpenCode Sessions, Lonely-Tomb Codespace, HF Vault) with Q-6 redaction. */

import {
  codespaceExec,
  codespaceStatus,
  codespaceSync,
  hfVaultDownload,
  hfVaultList,
  hfVaultStatus,
  hfVaultUpload,
  HttpGBrainMcpClient,
  opencodeSessionRead,
  opencodeSessionSearch,
  redactSecrets,
  type GraphNode,
  type SubprocessRunner,
} from '../../memory-core/src/index.ts'
import {
  AsyncSemaphore,
  OLLAMA_DEFAULT_MAX_CONCURRENT,
  resolveOllamaApiKey,
  runKimiClawDeepResearch,
} from './web-providers.ts'

export interface DshToolOutput {
  schema: Record<string, unknown>
  render: (args: Record<string, unknown>, value: DshToolResultValue) => Array<{ type: 'text'; text: string }>
}

export interface DshToolResultValue {
  ok: boolean
  summary: string
  dataJson: string
}

export interface DshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: DshToolOutput
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<DshToolResultValue>
}

export interface DshToolRegistryLike {
  register: (def: DshToolDefinition) => (() => void) | void
}

export interface BridgeToolsOptions {
  everosUrl?: string
  gbrainUrl?: string
  gbrainToken?: string
  dshHome?: string
  ollamaApiKey?: string
  ollamaBaseUrl?: string
  credentialsService?: { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
  ollamaSemaphore?: AsyncSemaphore
  opencodeUrl?: string
  opencodeDbPath?: string
  yesterdayDir?: string
  corpusPath?: string
  runner?: SubprocessRunner
  fetchFn?: typeof fetch
  onLog?: (event: string, details?: Record<string, unknown>) => void
}

const STANDARD_TOOL_OUTPUT: DshToolOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: 'Whether the bridge call succeeded.' },
      summary: { type: 'string', description: 'Concise redacted summary of the bridge output.' },
      dataJson: { type: 'string', description: 'Q-6 redacted JSON payload.' },
    },
    required: ['ok', 'summary', 'dataJson'],
  },
  render: (_args, value) => [{ type: 'text', text: `${value.summary}\n${value.dataJson}` }],
}

function packResult(ok: boolean, summary: string, data: unknown): DshToolResultValue {
  const redSummary = redactSecrets(summary).text
  const redJson = redactSecrets(JSON.stringify(data, null, 2)).text
  return { ok, summary: redSummary, dataJson: redJson }
}

export function buildBridgeToolDefinitions(options: BridgeToolsOptions = {}): DshToolDefinition[] {
  const log = options.onLog ?? (() => {})

  return [
    {
      name: 'opencode_session_search',
      description:
        'Search all 5,341 rows of "Yesterday session stopped by network issues" (ses_f31d8cd0dffeigmeSZY42Gqr2F), its forks, yesterday_session_files_manifest.json (2,262 paths), and all 81 non-Antigravity OpenCode sessions in opencode.db (with Q-6 secret redaction).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search across OpenCode & Yesterday sessions.' },
          sessionId: { type: 'string', description: 'Optional session ID (or "yesterday" / "manifest") to scope the search.' },
          limit: { type: 'integer', description: 'Max hits to return (1..50, default 10).' },
        },
        required: ['query'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = opencodeSessionSearch({
          query: String(args.query ?? ''),
          sessionId: typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          opencodeDbPath: options.opencodeDbPath,
          yesterdayDir: options.yesterdayDir,
          corpusPath: options.corpusPath,
        })
        log('tool_opencode_session_search', {
          queryLen: String(args.query ?? '').length,
          totalMatches: res.totalMatches,
          returned: res.results.length,
          redacted: res.redactedSecretsCount,
        })
        return packResult(
          !res.blockedReason,
          res.blockedReason ||
            `Found ${res.totalMatches} match(es) across [${res.searchedSources.join(', ')}]; returning ${res.results.length}.`,
          res,
        )
      },
    },
    {
      name: 'opencode_session_read',
      description:
        'Page through any non-Antigravity OpenCode session (including all 5,341 rows of ses_f31d8cd0dffeigmeSZY42Gqr2F / "yesterday" and "manifest") with offset/limit and Q-6 secret redaction.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: 'OpenCode session ID, "yesterday", or "manifest".' },
          offset: { type: 'integer', description: '0-based row offset (default 0).' },
          limit: { type: 'integer', description: 'Rows per page (1..100, default 20).' },
        },
        required: ['sessionId'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = opencodeSessionRead({
          sessionId: String(args.sessionId ?? ''),
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          opencodeDbPath: options.opencodeDbPath,
          yesterdayDir: options.yesterdayDir,
        })
        log('tool_opencode_session_read', {
          sessionId: res.sessionId,
          totalRows: res.totalRows,
          returned: res.rows.length,
          excluded: Boolean(res.excluded),
        })
        return packResult(
          !res.excluded && res.totalRows > 0,
          res.message || `Read ${res.rows.length} row(s) (offset ${res.offset}..${res.nextOffset} of ${res.totalRows}) from ${res.sessionId}.`,
          res,
        )
      },
    },
    {
      name: 'codespace_status',
      description: 'Check lonely-tomb Codespace state and live HTTP health of tunneled EverOS (:8000), GBrain (:3131), and OpenCode Web (:7860).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codespace: { type: 'string', description: 'Optional Codespace name (defaults to lonely-tomb-vpv6pjr956wqc6ggw).' },
        },
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await codespaceStatus({
          codespace: typeof args.codespace === 'string' && args.codespace.trim() ? args.codespace.trim() : undefined,
          everosUrl: options.everosUrl,
          gbrainUrl: options.gbrainUrl,
          opencodeUrl: options.opencodeUrl,
          runner: options.runner,
          fetchFn: options.fetchFn,
        })
        log('tool_codespace_status', { state: res.codespaceState })
        return packResult(
          res.endpoints.everos.ok || res.endpoints.gbrain.ok || res.endpoints.opencode.ok || res.codespaceState === 'Available',
          `Codespace ${res.codespace} state=${res.codespaceState} (everos=${res.endpoints.everos.ok}, gbrain=${res.endpoints.gbrain.ok}, opencode=${res.endpoints.opencode.ok})`,
          res,
        )
      },
    },
    {
      name: 'codespace_exec',
      description: 'Execute a shell command inside lonely-tomb Codespace via gh codespace ssh (with Q-6 secret redaction on output).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cmd: { type: 'string', description: 'Shell command to run inside lonely-tomb.' },
          codespace: { type: 'string', description: 'Optional Codespace name.' },
        },
        required: ['cmd'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await codespaceExec({
          cmd: String(args.cmd ?? ''),
          codespace: typeof args.codespace === 'string' && args.codespace.trim() ? args.codespace.trim() : undefined,
          runner: options.runner,
        })
        log('tool_codespace_exec', { exitCode: res.exitCode, redacted: res.redactedSecretsCount })
        return packResult(res.exitCode === 0, `codespace_exec exit=${res.exitCode}`, res)
      },
    },
    {
      name: 'codespace_sync',
      description: 'Sync files between local Windows host and lonely-tomb Codespace via gh codespace cp (blocks uploading secret files).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'push', 'pull', 'upload', 'download'],
            description: 'Transfer direction: up/push/upload (local->codespace) or down/pull/download (codespace->local).',
          },
          path: { type: 'string', description: 'Source path (local path for up, remote path for down).' },
          remotePath: { type: 'string', description: 'Optional destination path.' },
          codespace: { type: 'string', description: 'Optional Codespace name.' },
        },
        required: ['direction', 'path'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await codespaceSync({
          direction: String(args.direction ?? 'down') as 'up' | 'down',
          path: String(args.path ?? ''),
          remotePath: typeof args.remotePath === 'string' && args.remotePath.trim() ? args.remotePath.trim() : undefined,
          codespace: typeof args.codespace === 'string' && args.codespace.trim() ? args.codespace.trim() : undefined,
          runner: options.runner,
        })
        log('tool_codespace_sync', { direction: res.direction, exitCode: res.exitCode })
        return packResult(res.exitCode === 0, `codespace_sync ${res.direction} exit=${res.exitCode}`, res)
      },
    },
    {
      name: 'hf_vault_list',
      description: 'List files stored in HuggingFace Cloud Vault dataset evergreen-rara/opencode-cloud-vault.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prefix: { type: 'string', description: 'Optional path prefix filter.' },
          repoId: { type: 'string', description: 'Optional HF dataset repo ID (default evergreen-rara/opencode-cloud-vault).' },
          limit: { type: 'integer', description: 'Max files to list (1..200, default 50).' },
        },
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await hfVaultList({
          prefix: typeof args.prefix === 'string' ? args.prefix : undefined,
          repoId: typeof args.repoId === 'string' && args.repoId.trim() ? args.repoId.trim() : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          runner: options.runner,
        })
        log('tool_hf_vault_list', { totalFiles: res.totalFiles, error: res.error })
        return packResult(!res.error, res.error || `Listed ${res.files.length} of ${res.totalFiles} file(s) in ${res.repoId}.`, res)
      },
    },
    {
      name: 'hf_vault_download',
      description: 'Download a file from evergreen-rara/opencode-cloud-vault to a local directory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filename: { type: 'string', description: 'Path inside the HF dataset repo.' },
          localDir: { type: 'string', description: 'Local target directory.' },
          repoId: { type: 'string', description: 'Optional HF dataset repo ID.' },
        },
        required: ['filename'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await hfVaultDownload({
          filename: String(args.filename ?? ''),
          localDir: typeof args.localDir === 'string' && args.localDir.trim() ? args.localDir.trim() : undefined,
          repoId: typeof args.repoId === 'string' && args.repoId.trim() ? args.repoId.trim() : undefined,
          runner: options.runner,
        })
        log('tool_hf_vault_download', { ok: res.ok, filename: res.filename })
        return packResult(res.ok, res.ok ? `Downloaded ${res.filename} -> ${res.localPath}` : `Download failed: ${res.error}`, res)
      },
    },
    {
      name: 'hf_vault_upload',
      description: 'Upload a local file to evergreen-rara/opencode-cloud-vault with Q-6 fail-closed secret scanning.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localPath: { type: 'string', description: 'Local file path to upload.' },
          pathInRepo: { type: 'string', description: 'Optional target path inside HF repo.' },
          repoId: { type: 'string', description: 'Optional HF dataset repo ID.' },
        },
        required: ['localPath'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await hfVaultUpload({
          localPath: String(args.localPath ?? ''),
          pathInRepo: typeof args.pathInRepo === 'string' && args.pathInRepo.trim() ? args.pathInRepo.trim() : undefined,
          repoId: typeof args.repoId === 'string' && args.repoId.trim() ? args.repoId.trim() : undefined,
          runner: options.runner,
        })
        log('tool_hf_vault_upload', { ok: res.ok, pathInRepo: res.pathInRepo })
        return packResult(res.ok, res.ok ? `Uploaded ${res.pathInRepo}` : `Upload blocked/failed: ${res.error}`, res)
      },
    },
    {
      name: 'hf_vault_status',
      description: 'Inspect reachability, privacy, and file count of evergreen-rara/opencode-cloud-vault.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoId: { type: 'string', description: 'Optional HF dataset repo ID.' },
        },
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const res = await hfVaultStatus({
          repoId: typeof args.repoId === 'string' && args.repoId.trim() ? args.repoId.trim() : undefined,
          runner: options.runner,
        })
        log('tool_hf_vault_status', { reachable: res.reachable, fileCount: res.fileCount })
        return packResult(
          res.reachable,
          res.reachable ? `HF Vault ${res.repoId} online (${res.fileCount ?? 0} files, private=${res.privateRepo}).` : `HF Vault unreachable: ${res.error}`,
          res,
        )
      },
    },
    {
      name: 'gbrain_recall',
      description: 'Query GBrain (:3131) hybrid RAG/KAG knowledge graph directly with bearer authentication.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Search query across GBrain pages and facts.' },
          limit: { type: 'integer', description: 'Max hits (1..20, default 5).' },
          mode: { type: 'string', enum: ['hybrid', 'keyword', 'vector'], description: 'Search mode.' },
        },
        required: ['query'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const client = new HttpGBrainMcpClient(options.gbrainUrl, options.gbrainToken, options.fetchFn)
        try {
          const hits = await client.query(String(args.query ?? ''), {
            topK: typeof args.limit === 'number' ? Math.max(1, Math.min(args.limit, 20)) : 5,
            mode: args.mode === 'keyword' || args.mode === 'vector' ? args.mode : 'hybrid',
          })
          log('tool_gbrain_recall', { count: hits.length })
          return packResult(true, `GBrain returned ${hits.length} hit(s).`, { hits })
        } catch (err) {
          return packResult(false, `GBrain recall failed: ${err instanceof Error ? err.message : String(err)}`, { hits: [] })
        }
      },
    },
    {
      name: 'gbrain_remember',
      description: 'Store a verified fact or session digest in GBrain (:3131); treats async write_pending cleanly.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity: { type: 'string', description: 'Target entity slug (e.g., projects/research-123).' },
          title: { type: 'string', description: 'Short fact/page title.' },
          summary: { type: 'string', description: 'Concise factual content (Q-6 secret-redacted before write).' },
          type: { type: 'string', enum: ['fact', 'preference', 'session', 'decision', 'entity'], description: 'Node type.' },
          project_id: { type: 'string', description: 'Project identifier.' },
        },
        required: ['entity', 'summary'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const client = new HttpGBrainMcpClient(options.gbrainUrl, options.gbrainToken, options.fetchFn)
        const cleanSummary = redactSecrets(String(args.summary ?? '')).text
        const cleanTitle = redactSecrets(String(args.title ?? args.entity ?? 'Memory Fact')).text
        const rawType = String(args.type ?? 'session')
        const nodeType: GraphNode['type'] =
          rawType === 'preference' || rawType === 'decision' || rawType === 'entity' ? rawType : 'session'
        try {
          const res = await client.putPage({
            id: String(args.entity ?? 'sessions/dsh'),
            type: nodeType,
            title: cleanTitle,
            summary: cleanSummary,
            date: new Date().toISOString().slice(0, 10),
            project_id: typeof args.project_id === 'string' ? args.project_id : 'default',
            source_tier: 2,
          })
          log('tool_gbrain_remember', { slug: res.slug, pending: Boolean(res.pending) })
          return packResult(
            res.ok,
            res.pending ? `GBrain accepted write for ${res.slug} (write_pending queued).` : `GBrain stored ${res.slug}.`,
            res,
          )
        } catch (err) {
          return packResult(false, `GBrain remember failed: ${err instanceof Error ? err.message : String(err)}`, { ok: false })
        }
      },
    },
    {
      name: 'gbrain_entity',
      description: 'Inspect a specific GBrain (:3131) entity/page by slug or name.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Entity slug or title.' },
        },
        required: ['name'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const client = new HttpGBrainMcpClient(options.gbrainUrl, options.gbrainToken, options.fetchFn)
        try {
          const page = await client.getPage(String(args.name ?? ''))
          log('tool_gbrain_entity', { found: Boolean(page) })
          return packResult(Boolean(page), page ? `Found GBrain entity ${page.id}.` : 'Entity not found.', { page })
        } catch (err) {
          return packResult(false, `GBrain entity lookup failed: ${err instanceof Error ? err.message : String(err)}`, { page: null })
        }
      },
    },
    {
      name: 'gbrain_context_pack',
      description: 'Fetch top GBrain hits plus 1-hop graph neighbors into a compact context bundle.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Topic or task intent.' },
          limit: { type: 'integer', description: 'Max primary hits (1..10, default 4).' },
        },
        required: ['query'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const client = new HttpGBrainMcpClient(options.gbrainUrl, options.gbrainToken, options.fetchFn)
        try {
          const topK = typeof args.limit === 'number' ? Math.max(1, Math.min(args.limit, 10)) : 4
          const hits = await client.query(String(args.query ?? ''), { topK, mode: 'hybrid' })
          const neighbors = await Promise.all(
            hits.slice(0, 2).map((h) => client.neighbors(h.id).catch(() => [])),
          )
          log('tool_gbrain_context_pack', { hits: hits.length })
          return packResult(true, `Packed ${hits.length} GBrain hits with graph neighbors.`, {
            hits,
            neighbors: neighbors.flat().slice(0, 6),
          })
        } catch (err) {
          return packResult(false, `GBrain context pack failed: ${err instanceof Error ? err.message : String(err)}`, { hits: [] })
        }
      },
    },
    {
      name: 'web_deep_research',
      description:
        'Kimi Claw multi-stage online research via Ollama Pro: query expansion, parallel ollama.com/api/web_search, Clef /v1/systemone zero-output-token URL/tier gate, bounded web_fetch + glm-5.3-flash/minimax-m3.1-flash extraction, and kimi-k2.7-code synthesis with citations.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Research question or topic.' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Optional explicit sub-queries (max 3).' },
          mode: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'Research depth vs speed.' },
          useClefAdvisor: { type: 'boolean', description: 'Use Clef /v1/systemone URL & tier gatekeeper (default true).' },
          compressionModel: { type: 'string', enum: ['glm-5.3-flash', 'minimax-m3.1-flash'], description: 'Fast extraction model.' },
          synthesisModel: { type: 'string', enum: ['kimi-k2.7-code', 'kimi-k2.6'], description: 'Deep synthesis model.' },
          maxFetchUrls: { type: 'integer', description: 'Max pages to fetch (1..5, default 4).' },
        },
        required: ['query'],
      },
      output: STANDARD_TOOL_OUTPUT,
      execute: async (args) => {
        const apiKey = await resolveOllamaApiKey({
          explicitKey: options.ollamaApiKey,
          dshHome: options.dshHome,
          credentialsService: options.credentialsService,
        })
        if (!apiKey) {
          return packResult(false, 'OLLAMA_API_KEY not configured in ~/.dsh/.credentials.yaml or environment.', {})
        }
        const semaphore = options.ollamaSemaphore ?? new AsyncSemaphore(OLLAMA_DEFAULT_MAX_CONCURRENT)
        const mode = args.mode === 'fast' || args.mode === 'deep' ? args.mode : 'balanced'
        const res = await runKimiClawDeepResearch(
          {
            query: String(args.query ?? ''),
            queries: Array.isArray(args.queries) ? args.queries.map(String) : undefined,
            mode,
            useClefAdvisor: args.useClefAdvisor !== false,
            compressionModel:
              args.compressionModel === 'minimax-m3.1-flash' ? 'minimax-m3.1-flash' : 'glm-5.3-flash',
            synthesisModel: args.synthesisModel === 'kimi-k2.6' ? 'kimi-k2.6' : 'kimi-k2.7-code',
            maxFetchUrls: typeof args.maxFetchUrls === 'number' ? args.maxFetchUrls : 4,
          },
          {
            apiKey,
            baseUrl: options.ollamaBaseUrl,
            semaphore,
            fetchFn: options.fetchFn,
          },
        )
        log('tool_web_deep_research', {
          mode: res.mode,
          queries: res.queriesRun.length,
          clefUsed: res.clefDecision.used,
          clefTier: res.clefDecision.routeTier,
          modelsUsed: res.modelsUsed,
        })
        return packResult(
          true,
          `Research complete (mode=${res.mode}, clef=${res.clefDecision.routeTier}, models=[${res.modelsUsed.join(', ')}], sources=${res.sources.length}).`,
          res,
        )
      },
    },
  ]
}

export function registerBridgeTools(toolsService: DshToolRegistryLike | undefined, options: BridgeToolsOptions = {}): () => void {
  if (!toolsService || typeof toolsService.register !== 'function') return () => {}
  const defs = buildBridgeToolDefinitions(options)
  const disposers: Array<() => void> = []
  for (const def of defs) {
    const disp = toolsService.register(def)
    if (typeof disp === 'function') disposers.push(disp)
  }
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // Ignore
      }
    }
  }
}
