/**
 * @evergreen-realm/dsh-memory-plugin — DeepSeek Harness Cordis Plugin (0.2.2-rc.1)
 *
 * Implements:
 * - Boot startup preflight (`runStartupPreflight`) verifying EverOS (:8000), GBrain (:3131),
 *   ingest-checkpoint.json, yesterday_session (5,341 rows + manifest), and pre-warming
 *   192-d semantic + BM25 HybridRetrievalIndex BEFORE Step 0 (`startup-preflight.json` + `dsh-plugin.log`).
 * - `agent/pre-step`: extracts real user prompt (`m.role === 'user' && m?.source?.kind === 'user'`),
 *   queries EverOS + GBrain + pre-warmed local index in parallel, enforces <=4,000 chars / topK=5
 *   + 15m TtlCache + takeOverCompaction, appends schema-valid `UserMessage`
 *   (`id`, `role: 'user'`, `content: [{ type: 'text', text }]`, `source: { kind: 'runtime-context', form: 'recall' }`),
 *   and mirrors recall into `ctx.systemPrompt.context(...)` for live DSH refreshContext admission.
 * - `agent/turn-stopping`: reads committed turn messages from `agent.session` (`snapshotEvents` /
 *   `deriveMessages` with fallback `agent.messages`), tracks per-session `lastCapturedSeq`, updates
 *   `app-session-context.json`, pushes to EverOS (:8000) & GBrain (:3131), and logs telemetry/errors
 *   to `dsh-plugin.log`.
 * - Native Cordis tools: `opencode_session_search`, `opencode_session_read`, `codespace_status`,
 *   `codespace_exec`, `codespace_sync`, `hf_vault_list`, `hf_vault_download`, `hf_vault_upload`,
 *   `hf_vault_status`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendPluginLog,
  defaultAppContextPath,
  deriveProjectId,
  isMemoryOptedOut,
  MemoryOrchestrator,
  redactSecrets,
  resolveEvergreenDir,
  runStartupPreflight,
  sanitizeScopeId,
  triggerEnsureStackDetached,
  updateLiveSessionState,
                                 
                       
                       
                            
                        
                 
                              
                        
} from './core/index.js'
import { registerBridgeTools,                          } from './tools.js'
import {
  AsyncSemaphore,
  OLLAMA_DEFAULT_MAX_CONCURRENT,
  ORDERED_FALLBACK_CHAIN,
  registerOllamaWebProviders,
  resolveOllamaApiKey,
                          
} from './web-providers.js'

export const name = 'evergreen-dsh-memory'
// Activate immediately in Cordis v4 (`inject` object keys are treated as required service names, NOT `{ optional: [...] }`);
// wire `tools` and `systemPrompt` dynamically via `ctx.inject` when available (and directly on test mocks).
export const inject = []         

                                                                          
                                   
                    
                       
                         
                     
                              
                        
                       
                  
                     
                         
                      
                        
                                 
                                 
                    
                                
                     
                          
                          
                                   
                           
                        
                       
                        
                              
                        
 

export function getDshGbrainMcpConfig(gbrainUrl = 'http://127.0.0.1:3131')   
              
             
                              
  {
  return {
    type: 'http',
    url: `${gbrainUrl.replace(/\/+$/, '')}/mcp`,
    transport: 'streamable-http',
  }
}

                                 
             
               
                   
                                                  
                     
                       
 

                                      
              
               
               
                                
 

                                 
             
              
                           
                                                                                                
                                                  
 

                               
             
              
                    
                          
                                      
           
                                                                             
                                                                               
                                                                                                  
   
 

                                    
                                                                                                            
                                                                   
                                 
                                                                                                 
                             
                  
                       
                  
                   
                           
                                                                   
                             
   
 

const SYNTHETIC_SOURCE_KINDS = new Set([
  'runtime-context',
  'dsh-time-context',
  'time-context',
  'skill-catalog',
  'system-prompt',
  'evergreen-dsh-memory',
  'session-reference',
])

function readTokenFromGbrainCreds(baseDir        )                     {
  const credsPath = process.env.GBRAIN_CREDENTIALS_FILE || join(baseDir, 'gbrain-creds.json')
  if (!existsSync(credsPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(credsPath, 'utf8'))                             
    return parsed.access_token || undefined
  } catch {
    return undefined
  }
}

export function extractDshMessageText(content         )         {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts           = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
    } else if (block && typeof block === 'object') {
      const b = block                           
      if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
      else if (typeof b.content === 'string' && b.content.trim()) parts.push(b.content)
      else if (typeof b.output === 'string' && b.output.trim()) parts.push(b.output)
    }
  }
  return parts.join('\n')
}

export function extractLatestRealUserMessage(messages                           )                             {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    if (m.source === undefined || m.source?.kind === 'user') return m
  }
  return undefined
}

                                      
                                     
                 
                    
                       
 

export function extractCommittedTurnMessages(
  agent                          ,
  lastCapturedSeqBySession                     ,
  sessionId        ,
)                                                                                {
  const session = agent?.session
  const prevSeq = lastCapturedSeqBySession.get(sessionId) ?? 0
  let maxSeqSeen = prevSeq
  let lastUserIntent                    
  const out                        = []

  if (session && typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents(prevSeq)
    for (const ev of events) {
      if (typeof ev.seq === 'number' && ev.seq >= maxSeqSeen) {
        maxSeqSeen = ev.seq + 1
      }
      const ts = typeof ev.time === 'number' ? ev.time : undefined
      const data = ev.data ?? {}

      if (ev.type === 'user/message') {
        const src = data.source                                 
        if (src?.kind && SYNTHETIC_SOURCE_KINDS.has(src.kind)) continue
        if (src?.kind && src.kind !== 'user') continue
        const text = extractDshMessageText(data.content).trim()
        if (!text) continue
        lastUserIntent = text
        out.push({ role: 'user', content: text, timestamp: ts })
      } else if (ev.type === 'assistant/message') {
        const msg = (data.message ?? data)                           
        const text = extractDshMessageText(msg.content).trim()
        if (!text) continue
        out.push({ role: 'assistant', content: text, timestamp: ts })
      } else if (ev.type === 'tool/result') {
        const msg = (data.message ?? data)                           
        const text = extractDshMessageText(msg.content).trim()
        if (!text) continue
        out.push({
          role: 'tool',
          content: text.slice(0, 2000),
          timestamp: ts,
          tool_call_id: typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
        })
      }
    }
    if (typeof session.seq === 'number' && session.seq > maxSeqSeen) {
      maxSeqSeen = session.seq
    }
    return { messages: out, nextSeq: maxSeqSeen, lastUserIntent }
  }

  // Fallback to session.deriveMessages() or legacy agent.messages
  const rawMsgs =
    session && typeof session.deriveMessages === 'function'
      ? session.deriveMessages()
      : Array.isArray(agent?.messages)
        ? agent.messages
        : []
  const slice = rawMsgs.slice(prevSeq)
  for (const m of slice) {
    if (!m) continue
    if (m.source?.kind && SYNTHETIC_SOURCE_KINDS.has(m.source.kind)) continue
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue
    const text = extractDshMessageText(m.content).trim()
    if (!text) continue
    if (m.role === 'user') lastUserIntent = text
    out.push({
      role: m.role,
      content: text,
      tool_call_id: m.toolCallId ?? m.tool_call_id,
    })
  }
  return { messages: out, nextSeq: rawMsgs.length, lastUserIntent }
}

                                        
                                  
                                                 
                              
 

export async function apply(ctx                   , cfg                        = {})                {
  const evergreenDir = resolveEvergreenDir(cfg.evergreenDir)
  const appContextPath = cfg.appContextPath || defaultAppContextPath()
  const pluginLogPath = cfg.pluginLogPath || join(evergreenDir, 'dsh-plugin.log')
  const gbrainToken = cfg.gbrainToken ?? readTokenFromGbrainCreds(evergreenDir)

  const orchestrator =
    cfg.orchestrator ??
    new MemoryOrchestrator({
      config: {
        appId: 'dsh',
        enableAppSessionAwareness: true,
        ...cfg,
        appContextPath,
        gbrainToken,
      },
      everos: cfg.everos,
      gbrain: cfg.gbrain,
      localIndex: cfg.localIndex,
    })

  if (cfg.localIndex && orchestrator.getLocalIndexSize() === 0) {
    orchestrator.setLocalIndex(cfg.localIndex)
  }

  const lastCapturedSeqBySession = new Map                ()
  const lastRecallKeyBySession = new Map                ()
  const fallbackTierBySession = new Map                ()
  let cachedAppContext                                       

  const preflightReady = runStartupPreflight({
    everos: orchestrator.everos,
    gbrain: orchestrator.gbrain,
    everosUrl: orchestrator.config.everosUrl,
    gbrainUrl: orchestrator.config.gbrainUrl,
    evergreenDir,
    appContextPath,
    checkpointPath: cfg.checkpointPath,
    corpusPath: cfg.corpusPath,
    preflightOutputPath: cfg.preflightOutputPath,
    pluginLogPath,
    yesterdayDir: cfg.yesterdayDir,
    dshHome: cfg.dshHome,
    researchWs: cfg.researchWs,
    maxCorpusDocs: cfg.maxCorpusDocs,
    recallMaxChars: orchestrator.config.recallMaxChars,
    recallTopK: orchestrator.config.recallTopK,
    autoHeal: cfg.autoHeal ?? (!cfg.everos && !cfg.gbrain),
    ensureStackScriptPath: cfg.ensureStackScriptPath,
    spawnFn: cfg.spawnFn,
  })
    .then((res) => {
      if (!cfg.localIndex || cfg.localIndex.size === 0) {
        orchestrator.setLocalIndex(res.localIndex)
      }
      cachedAppContext = res.appContext
      return res
    })
    .catch((err) => {
      appendPluginLog(pluginLogPath, 'startup_preflight_error', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    })

  const credentialsService = (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined)   
                                                                            
               
  const ollamaSemaphore = new AsyncSemaphore(cfg.ollamaMaxConcurrent ?? OLLAMA_DEFAULT_MAX_CONCURRENT)

  const toolOpts = {
    everosUrl: orchestrator.config.everosUrl,
    gbrainUrl: orchestrator.config.gbrainUrl,
    gbrainToken,
    dshHome: cfg.dshHome,
    ollamaApiKey: cfg.ollamaApiKey,
    ollamaBaseUrl: cfg.ollamaBaseUrl,
    credentialsService,
    ollamaSemaphore,
    opencodeUrl: cfg.opencodeUrl,
    opencodeDbPath: cfg.opencodeDbPath,
    yesterdayDir: cfg.yesterdayDir,
    corpusPath: cfg.corpusPath,
    runner: cfg.runner,
    fetchFn: cfg.fetchFn,
    onLog: (event        , details                          ) => appendPluginLog(pluginLogPath, event, details),
  }

  // Register all bridge tools (Evergreen sessions/vault + GBrain RAG/KAG + Kimi Claw web_deep_research)
  let disposeTools             = () => {}
  const directTools = (typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools)                                   
  if (directTools && typeof directTools.register === 'function') {
    disposeTools = registerBridgeTools(directTools, toolOpts)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => registerBridgeTools(toolsCtx.tools, toolOpts))
  }

  // Register native Ollama + Clef/Kimi SearchProvider & FetchProvider on ctx.web
  let disposeWeb             = () => {}
  const directWeb = (typeof ctx.get === 'function' ? ctx.get('web') : (ctx                                ).web)   
                        
               
  const webOpts = {
    dshHome: cfg.dshHome,
    apiKey: cfg.ollamaApiKey,
    baseUrl: cfg.ollamaBaseUrl,
    credentialsService,
    semaphore: ollamaSemaphore,
    fetchFn: cfg.fetchFn,
    onLog: (event        , details                          ) => appendPluginLog(pluginLogPath, event, details),
  }
  if (directWeb && (typeof directWeb.registerSearchProvider === 'function' || typeof directWeb.registerFetchProvider === 'function')) {
    disposeWeb = registerOllamaWebProviders(directWeb, webOpts)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['web'], (webCtx) => {
      const w = (webCtx                                           ).web
      return w ? registerOllamaWebProviders(w, webOpts) : undefined
    })
  }

  // Keep systemPrompt static across turns (empty hook) so per-turn recall never mutates Message[0]
  // and never breaks provider KV prefix caching ($0.006/1M cached vs $0.30/1M uncached).
  // Dynamic per-turn recall is injected append-only at the tail via agent/pre-step runtime-context.
  const promptContextEntry = {
    name: 'evergreen-memory-recall',
    order: 95,
    interpolate: false,
    text: () => '',
  }
  let disposeContext                     
  const directSystemPrompt = (typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt)                                     
  if (directSystemPrompt && typeof directSystemPrompt.context === 'function') {
    disposeContext = directSystemPrompt.context(promptContextEntry)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (spCtx) => {
      if (spCtx.systemPrompt && typeof spCtx.systemPrompt.context === 'function') {
        return spCtx.systemPrompt.context(promptContextEntry)
      }
      return undefined
    })
  }

  ctx.on(
    'agent/pre-step',
    async (rawPayload         , rawNext         ) => {
      const payload = (rawPayload ?? {})     
                            
                                   
                     
                     
                            
       
      const next = typeof rawNext === 'function'
        ? (rawNext                                                                                       )
        : undefined

      try {
        await preflightReady
      } catch {
        // Fail-open on preflight errors; already logged
      }

      const fallbackAgentMsgs = Array.isArray(payload.agent?.messages) ? (payload.agent .messages                    ) : []
      const decision = next
        ? await next()
        : { kind: 'continue', messages: Array.isArray(payload.messages) ? payload.messages : fallbackAgentMsgs }
      if (decision?.kind === 'reject' || payload.signal?.aborted) return decision

      const decisionMsgs = Array.isArray(decision?.messages) ? decision.messages : []
      const payloadMsgs = Array.isArray(payload.messages) ? payload.messages : fallbackAgentMsgs
      const sourceMsgs = decisionMsgs.length > 0 ? decisionMsgs : payloadMsgs

      const lastRealUser = extractLatestRealUserMessage(sourceMsgs)
      if (!lastRealUser) return decision

      const query = extractDshMessageText(lastRealUser.content).trim()
      if (!query) return decision

      const agent = payload.agent
      const cwd = agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd()
      const sessionId = String(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? 'dsh-session')
      const projectId = deriveProjectId(cwd)

      if (isMemoryOptedOut({ cwd, text: query })) return decision

      // Track A fix: seed initial session seq when resuming an existing session so turn-stopping
      // captures only the active turn onward (prevents 1,036-msg historical replay & budget cap).
      if (!lastCapturedSeqBySession.has(sessionId)) {
        const curSeq =
          typeof agent?.session?.seq === 'number'
            ? agent.session.seq
            : typeof agent?.session?.deriveMessages === 'function'
              ? agent.session.deriveMessages().length
              : sourceMsgs.length
        const seedSeq = curSeq <= 8 ? 0 : Math.max(0, curSeq - 4)
        lastCapturedSeqBySession.set(sessionId, seedSeq)
      }

      // Skip redundant recall on trivial continuation acks once session already has initial recall
      if (
        lastRecallKeyBySession.has(sessionId) &&
        query.length <= 12 &&
        /^(ok|okay|yes|y|go|continue|next|done|thanks|thx)[.!?\s]*$/iu.test(query)
      ) {
        return decision
      }

      // Do not re-inject duplicate recall within the same turn's subsequent tool steps (step > 0)
      const turnKey = `${payload.turn ?? 0}:${lastRealUser.id ?? query}`
      if ((payload.step ?? 0) > 0 && lastRecallKeyBySession.get(sessionId) === turnKey) {
        return decision
      }

      // Compaction takeover when transcript exceeds context threshold
      let compactionSuffix = ''
      const approxHistoryTokens = Math.ceil(
        sourceMsgs.reduce((acc, m) => acc + extractDshMessageText(m?.content).length, 0) / 4,
      )
      if (sourceMsgs.length >= 24 || approxHistoryTokens >= 14000) {
        const recent = sourceMsgs
          .filter((m) => !(m?.source?.kind && SYNTHETIC_SOURCE_KINDS.has(m.source.kind)))
          .slice(-12)
          .map((m) => ({
            role: m.role ?? 'user',
            content: extractDshMessageText(m.content).slice(0, 4000),
          }))
        const comp = orchestrator.takeOverCompaction({
          sessionId,
          projectId,
          messages: recent,
          openTodos: cachedAppContext?.liveSession?.openActions,
        })
        if (comp.summary) compactionSuffix = `\n${comp.summary.slice(0, 600)}`
      }

      const unassistedBaselineTokens = Math.max(2200, approxHistoryTokens + 900)
      const res = await orchestrator.recall({
        query,
        cwd,
        sessionId,
        projectId,
        fencedTag: cfg.fencedTag ?? 'evergreen_memory',
        includeAppContext: true,
        appContext: cachedAppContext,
        unassistedBaselineTokens,
      })

      if (!res.block) return decision

      lastRecallKeyBySession.set(sessionId, turnKey)

      const maxChars = orchestrator.config.recallMaxChars || 4000
      const finalText = compactionSuffix ? `${res.block}\n${compactionSuffix}`.slice(0, maxChars) : res.block

      const stats = orchestrator.getStats()
      const pctSaved =
        stats.estimatedTokensBaseline > 0
          ? Number(((stats.estimatedTokensSaved / stats.estimatedTokensBaseline) * 100).toFixed(1))
          : 0
      appendPluginLog(pluginLogPath, 'pre_step_recall', {
        sessionId,
        turn: payload.turn ?? 0,
        step: payload.step ?? 0,
        charCount: finalText.length,
        itemsCount: res.items.length,
        cacheHit: res.cacheHit,
        latencyMs: res.latencyMs,
        mode: res.mode,
        tokensInjected: res.tokensInjected,
        cumulativeSavedPct: pctSaved,
      })

      const recallMessage = {
        id: randomUUID(),
        role: 'user'         ,
        content: [{ type: 'text'         , text: finalText }],
        source: { kind: 'runtime-context'         , form: 'recall'          },
      }

      const baseMessages = decisionMsgs.length > 0 ? decisionMsgs : payloadMsgs
      const surfaceBudget = cfg.maxSurfaceTokensBudget ?? 700_000
      const estimateMsgsTokens = (msgs                           )         =>
        msgs.reduce((sum, m) => sum + Math.ceil((extractDshMessageText(m?.content).length + 32) / 3), 0)

      let outgoingBase                   = [...baseMessages]
      const preGuardTokens = estimateMsgsTokens(outgoingBase)
      let effectiveRecallText = finalText

      if (preGuardTokens >= Math.floor(surfaceBudget * 0.85)) {
        effectiveRecallText = finalText.slice(0, 1200)
        appendPluginLog(pluginLogPath, 'pre_step_surface_pressure', {
          sessionId,
          estimatedTokens: preGuardTokens,
          budget: surfaceBudget,
          messageCount: outgoingBase.length,
        })
      }

      if (preGuardTokens > surfaceBudget && outgoingBase.length > 2) {
        const leadingSystem = outgoingBase.filter((m, idx) => idx === 0 && m?.role === 'system')
        const body = outgoingBase.slice(leadingSystem.length)
        const keepBudget = Math.floor(surfaceBudget * 0.65)
        const keptTail                   = []
        let tailTok = 0
        for (let i = body.length - 1; i >= 0; i--) {
          const item = body[i]
          const t = Math.ceil((extractDshMessageText(item?.content).length + 32) / 3)
          if (keptTail.length > 0 && tailTok + t > keepBudget) break
          keptTail.unshift(item)
          tailTok += t
        }
        const droppedCount = Math.max(0, body.length - keptTail.length)
        if (droppedCount > 0) {
          const dropped = body.slice(0, droppedCount).slice(-24).map((m) => ({
            role: m?.role ?? 'user',
            content: extractDshMessageText(m?.content).slice(0, 1200),
          }))
          const emergencyComp = orchestrator.takeOverCompaction({
            sessionId,
            projectId,
            messages: dropped,
            openTodos: cachedAppContext?.liveSession?.openActions,
          })
          const summaryMsg                 = {
            id: randomUUID(),
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<evergreen_emergency_compaction droppedMessages="${droppedCount}" beforeTokens="${preGuardTokens}">\n${
                  emergencyComp.summary || `Compacted ${droppedCount} earlier messages to fit DeepSeek context window.`
                }\n</evergreen_emergency_compaction>`,
              },
            ],
            source: { kind: 'runtime-context', form: 'recall' },
          }
          outgoingBase = [...leadingSystem, summaryMsg, ...keptTail]
          const afterTokens = estimateMsgsTokens(outgoingBase)
          appendPluginLog(pluginLogPath, 'pre_step_emergency_compaction', {
            sessionId,
            droppedCount,
            beforeTokens: preGuardTokens,
            afterTokens,
            budget: surfaceBudget,
          })
        }
      }

      const gatedRecallMessage =
        effectiveRecallText === finalText
          ? recallMessage
          : {
              ...recallMessage,
              content: [{ type: 'text'         , text: effectiveRecallText }],
            }

      return {
        ...decision,
        messages: [...outgoingBase, gatedRecallMessage],
      }
    },
    { prepend: true },
  )

  ctx.on('agent/turn-stopping', async (rawPayload         ) => {
    const payload = (rawPayload ?? {})                                           
    const agent = payload.agent
    const cwd = agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd()
    const sessionId = String(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? 'dsh-session')
    const projectId = deriveProjectId(cwd)

    const { messages, nextSeq, lastUserIntent } = extractCommittedTurnMessages(agent, lastCapturedSeqBySession, sessionId)
    lastCapturedSeqBySession.set(sessionId, nextSeq)

    if (messages.length === 0) return

    const combinedText = messages.map((m) => m.content).join('\n')
    if (isMemoryOptedOut({ cwd, text: combinedText })) return

    try {
      const cap = await orchestrator.capture({
        sessionId,
        cwd,
        projectId,
        messages,
      })
      if (cap.skippedReason && cap.skippedReason !== 'memory-off') {
        appendPluginLog(pluginLogPath, 'turn_stopping_capture_warning', {
          sessionId,
          skippedReason: cap.skippedReason,
          messageCount: messages.length,
        })
      } else {
        appendPluginLog(pluginLogPath, 'turn_stopping_capture', {
          sessionId,
          captured: cap.captured,
          flushed: cap.flushed,
          nextSeq,
        })
      }
    } catch (err) {
      appendPluginLog(pluginLogPath, 'turn_stopping_capture_error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      if (cfg.autoHeal ?? (!cfg.everos && !cfg.gbrain)) {
        triggerEnsureStackDetached({
          reason: 'turn_stopping_capture_error',
          evergreenDir,
          pluginLogPath,
          ensureStackScriptPath: cfg.ensureStackScriptPath,
          spawnFn: cfg.spawnFn,
        })
      }
    }

    try {
      cachedAppContext = updateLiveSessionState(
        {
          activeWorkspace: cwd,
          activeSessionId: sessionId,
          lastUserIntent: lastUserIntent ? redactSecrets(lastUserIntent).text.slice(0, 240) : undefined,
        },
        { path: appContextPath, cwd },
      )
    } catch (err) {
      appendPluginLog(pluginLogPath, 'turn_stopping_context_error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Push a lightweight Q-14 budgeted turn digest to GBrain (:3131) when substantive turn completes
    if (!cfg.disableGbrainTurnPush && messages.length >= 2 && orchestrator.budgetGuard.canWrite(1)) {
      try {
        const digestLines = messages
          .slice(-4)
          .map((m) => `[${m.role}] ${redactSecrets(m.content).text.slice(0, 400)}`)
          .join('\n')
        const slug = `sessions/${sanitizeScopeId(sessionId, 'dsh-session')}`
        await orchestrator.gbrain.putPage(
          {
            id: slug,
            type: 'session',
            title: `DSH Session ${sessionId}`,
            summary: digestLines,
            date: new Date().toISOString().slice(0, 10),
            project_id: projectId,
            source_tier: 2,
          },
          [{ from: slug, to: `repos/${projectId}`, relation: 'belongs_to' }],
        )
        orchestrator.budgetGuard.consumeWrite(1)
      } catch (err) {
        appendPluginLog(pluginLogPath, 'turn_stopping_gbrain_error', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        if (cfg.autoHeal ?? (!cfg.everos && !cfg.gbrain)) {
          triggerEnsureStackDetached({
            reason: 'turn_stopping_gbrain_error',
            evergreenDir,
            pluginLogPath,
            ensureStackScriptPath: cfg.ensureStackScriptPath,
            spawnFn: cfg.spawnFn,
          })
        }
      }
    }
  })

  // Ordered 3-tier Ollama Cloud fallback (deepseek-v4.1-flash -> glm-5.3-flash -> minimax-m3.1-flash)
  if (cfg.autoFailover !== false) {
    ctx.on('agent/request-error', async (rawPayload         , rawNext         ) => {
      const nextFn = typeof rawNext === 'function' ? (rawNext                          ) : undefined
      const payload = (rawPayload ?? {})     
                            
                         
                                                                          
       
      const errCode = String(payload.failure?.code ?? '')
      const errMsg = String(payload.failure?.message ?? '')
      const terminalFailure =
        /QUOTA|ACCOUNT_QUOTA|RATE_LIMIT|UNAVAILABLE|EMPTY_RESPONSE|TIMEOUT|OVERLOADED/iu.test(`${errCode} ${errMsg}`) ||
        (typeof payload.failure?.statusCode === 'number' &&
          (payload.failure.statusCode === 429 || payload.failure.statusCode >= 500))

      const selectFn = payload.agent?.model?.select
      const sid = String(payload.agent?.session?.id ?? payload.agent?.sessionId ?? payload.agent?.id ?? 'dsh-session')
      const curIdx = fallbackTierBySession.get(sid) ?? 0
      if (terminalFailure && typeof selectFn === 'function' && curIdx < ORDERED_FALLBACK_CHAIN.length) {
        const apiKey = await resolveOllamaApiKey({
          explicitKey: cfg.ollamaApiKey,
          dshHome: cfg.dshHome,
          credentialsService,
        })
        if (apiKey) {
          const nextTarget = ORDERED_FALLBACK_CHAIN[curIdx] 
          fallbackTierBySession.set(sid, curIdx + 1)
          try {
            selectFn({
              provider: nextTarget.provider,
              model: nextTarget.model,
              reasoningEffort: 'high',
            })
            appendPluginLog(pluginLogPath, 'llm_failover_selected', {
              sessionId: sid,
              fromProvider: payload.provider ?? 'unknown',
              toProvider: nextTarget.provider,
              toModel: nextTarget.model,
              tierIndex: curIdx,
              failureCode: errCode,
            })
          } catch (err) {
            appendPluginLog(pluginLogPath, 'llm_failover_error', {
              sessionId: sid,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      return nextFn ? nextFn() : undefined
    })
  }

  let disposePromise                           
  const disposeAll = () => {
    disposePromise ??= (async () => {
      try {
        if (typeof (orchestrator                                 ).flushAllPending === 'function') {
          await orchestrator.flushAllPending()
        }
      } catch (err) {
        appendPluginLog(pluginLogPath, 'dispose_flush_error', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      orchestrator.dispose()
      if (typeof disposeContext === 'function') {
        try {
          disposeContext()
        } catch {
          // Ignore
        }
      }
      disposeWeb()
      disposeTools()
    })()
    return disposePromise
  }

  ctx.on('session/disposed', async (rawSes         ) => {
    const ses = (rawSes ?? {})                   
    const sid = ses.id
    if (sid) {
      try {
        await orchestrator.flushSession(sid)
      } catch (err) {
        appendPluginLog(pluginLogPath, 'session_disposed_flush_error', {
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })

  ctx.on('dispose', disposeAll)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void disposeAll()
    })
  }

  await preflightReady.catch(() => {})
}
