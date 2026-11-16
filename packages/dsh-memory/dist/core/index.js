/** Unified MemoryOrchestrator combining EverOS (MAG), GBrain (RAG/KAG-lite §4-B), Redaction (Q-6), Budget (Q-5/Q-14), & Approval Promotion (Q-3). */

import { basename, resolve } from 'node:path'

import {
  buildCompactionSummary,
  DailyBudgetGuard,
  estimateTokens,
  packRecallBlock,
  StatsLedger,
  TtlCache,
} from './budget.js'
import { HttpEverosClient, sanitizeScopeId,                      } from './everos-client.js'
import { HttpGBrainMcpClient,                      } from './gbrain-client.js'
import { kagLiteSearch, parseLogicalForm } from './kag-lite.js'
import { isMemoryOptedOut, redactSecrets } from './redactor.js'
import { HybridRetrievalIndex } from './retrieval.js'
import {
  formatAppSessionAwarenessBlock,
  loadAppSessionContext,
                                 
} from './workspace-context.js'
             
                   
                      
              
                     
                   
               
                 
                   

export * from './types.js'
export * from './redactor.js'
export * from './budget.js'
export * from './everos-client.js'
export * from './gbrain-client.js'
export * from './retrieval.js'
export * from './kag-lite.js'
export * from './workspace-context.js'
export * from './corpus-bridge.js'
export * from './remote-bridges.js'
export * from './preflight.js'

export function defaultMemoryConfig(overrides                            = {})                   {
  const user = (() => {
    const envUser = process.env.EVERGREEN_USER_ID?.trim()
    if (envUser) return sanitizeScopeId(envUser, 'evergreen')
    return 'evergreen'
  })()

  return {
    everosUrl: process.env.EVEROS_URL ?? 'http://127.0.0.1:8000',
    gbrainUrl: process.env.GBRAIN_URL ?? 'http://127.0.0.1:3131',
    appId: 'opencode',
    userId: user,
    agentId: 'default-agent',
    crossAppIds: ['opencode', 'dsh', 'import-opencode', 'import-workspace-audit', 'import-dsh', 'import-manifest', 'import-workspace-docs'],
    recallMethod: 'hybrid',
    enableKagLite: true,
    recallTopK: 5,
    recallMaxChars: 4000,
    cacheTtlMs: 15 * 60 * 1000,
    recallTimeoutMs: 10000,
    captureTimeoutMs: 15000,
    flushIdleMs: 30000,
    flushTokenThreshold: 12000,
    flushMessageThreshold: 50,
    flushMaxDelayMs: 300000,
    dailyWriteCap: 250,
    ...overrides,
  }
}

export function deriveProjectId(cwd         )         {
  if (!cwd) return 'default'
  const abs = resolve(cwd)
  return sanitizeScopeId(basename(abs) || 'workspace', 'workspace')
}

                                
                   
                         
                       
                         
                                           
                                          
 

export class MemoryOrchestrator {
           config                  
           everos                 
           gbrain                 
           cache                        
           budgetGuard                  
           stats             
          localIndex                       
                   sessionBuffers = new Map                              ()
                   pendingPromotions = new Map                            ()

  constructor(options   
                                      
                            
                            
                                     
    = {}) {
    this.config = defaultMemoryConfig(options.config)
    this.everos = options.everos ?? new HttpEverosClient(this.config.everosUrl)
    this.gbrain = options.gbrain ?? new HttpGBrainMcpClient(this.config.gbrainUrl, this.config.gbrainToken)
    this.localIndex = options.localIndex
    this.cache = new TtlCache              (this.config.cacheTtlMs)
    this.budgetGuard = new DailyBudgetGuard(this.config.dailyWriteCap)
    this.stats = new StatsLedger(this.config.statsPath)
  }

  setLocalIndex(index                      )       {
    this.localIndex = index
  }

  getLocalIndexSize()         {
    return this.localIndex?.size() ?? 0
  }

          mapEverosHits(res                            , source                                )                     {
    if (!res) return []
    const items                     = []
    for (const ep of res.episodes ?? []) {
      items.push({
        id: ep.id,
        source,
        title: ep.subject || 'Episode',
        snippet: ep.summary || ep.episode,
        score: ep.score ?? 0.5,
        date: ep.timestamp,
        project_id: ep.project_id,
      })
    }
    for (const cs of res.agent_cases ?? []) {
      items.push({
        id: cs.id,
        source,
        title: cs.task_intent,
        snippet: `${cs.approach}${cs.key_insight ? ` (${cs.key_insight})` : ''}`,
        score: cs.score ?? cs.quality_score ?? 0.5,
      })
    }
    for (const sk of res.agent_skills ?? []) {
      items.push({
        id: sk.id,
        source,
        title: `Skill: ${sk.name}`,
        snippet: sk.description || sk.content,
        score: sk.score ?? sk.confidence ?? 0.5,
      })
    }
    return items
  }

  /** Parallel dual-track EverOS + GBrain/KAG-lite recall, cached & capped at <=4,000 chars / topK=5. */
  async recall(params   
                 
                
                      
                      
                    
                      
                                     
                               
                                          
   )                        {
    const start = performance.now()
    if (!params.query.trim() || isMemoryOptedOut({ cwd: params.cwd, text: params.query })) {
      return {
        block: '',
        items: [],
        cacheHit: false,
        latencyMs: 0,
        charCount: 0,
        tokensInjected: 0,
        mode: this.config.recallMethod,
      }
    }

    const wantAppCtx = params.includeAppContext ?? Boolean(this.config.enableAppSessionAwareness)
    const projectId = params.projectId ?? deriveProjectId(params.cwd)
    const scope = `${this.config.appId}:${projectId}:${this.config.recallMethod}:${this.config.enableKagLite}:${wantAppCtx}:${params.sessionId ?? ''}`
    const cacheKey = TtlCache.makeKey(params.query, scope)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      const latencyMs = Number((performance.now() - start).toFixed(2))
      this.stats.recordRecall({
        cacheHit: true,
        latencyMs,
        tokensInjected: 0, // Cache hit avoided fresh retrieval / repeat stuffing
        estimatedBaselineTokens: params.unassistedBaselineTokens ?? Math.max(800, cached.tokensInjected * 3),
      })
      return { ...cached, cacheHit: true, latencyMs }
    }

    const lf = parseLogicalForm(params.query)
    const useKag = this.config.enableKagLite && (lf.matchedByRule || params.query.length > 25)

    // Parallel fail-open queries across EverOS (primary + cross-harness app scopes) and GBrain / KAG-lite
    const searchApps = Array.from(
      new Set([this.config.appId, ...(this.config.crossAppIds ?? [])].map((a) => sanitizeScopeId(a, 'default'))),
    )

    const [userResList, agentRes, gbrainItems, localItems] = await Promise.all([
      Promise.all(
        searchApps.map((appScope) =>
          this.everos
            .search(
              {
                user_id: this.config.userId,
                app_id: appScope,
                project_id: projectId,
                query: params.query,
                method: this.config.recallMethod,
                top_k: this.config.recallTopK,
                include_profile: appScope === this.config.appId,
              },
              this.config.recallTimeoutMs,
            )
            .catch(() => undefined),
        ),
      ),
      this.everos
        .search(
          {
            agent_id: sanitizeScopeId(params.agentId ?? this.config.agentId, 'agent'),
            app_id: this.config.appId,
            project_id: projectId,
            query: params.query,
            // Agent track hybrid in EverOS 1.6 requires optional [rerank]; keyword avoids 422 when rerank is unset
            method: 'keyword',
            top_k: this.config.recallTopK,
          },
          this.config.recallTimeoutMs,
        )
        .catch(() => undefined),
      (useKag
        ? kagLiteSearch(params.query, this.gbrain, { topK: this.config.recallTopK }).then((r) => r.items)
        : this.gbrain.query(params.query, { topK: this.config.recallTopK, mode: 'hybrid' }).then((hits) =>
            hits.map((h) => ({
              id: h.id,
              source: 'gbrain-hybrid'         ,
              title: h.title,
              snippet: h.snippet,
              score: h.score,
              date: h.date,
              project_id: projectId,
            })),
          )
      ).catch(() => []                      ),
      Promise.resolve().then(()                     => {
        if (!this.localIndex || this.localIndex.size() === 0) return []
        return this.localIndex.searchHybridRRF(params.query, { topK: this.config.recallTopK }).map((h) => ({
          id: h.doc.id,
          source: 'local-hybrid'         ,
          title: h.doc.title || h.doc.id,
          snippet: h.doc.text,
          score: h.score,
          date: h.doc.date,
          project_id: h.doc.project_id ?? projectId,
        }))
      }),
    ])

    const seenKeys = new Set        ()
    const rawCandidates                     = [
      ...userResList.flatMap((res) => this.mapEverosHits(res, 'everos-user')),
      ...this.mapEverosHits(agentRes, 'everos-agent'),
      ...gbrainItems,
      ...localItems,
    ]
    const allCandidates                     = []
    for (const item of rawCandidates) {
      const dedupeKey = `${item.id}:${item.snippet.slice(0, 80).toLowerCase()}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      allCandidates.push(item)
    }

    const awarenessBlock = wantAppCtx
      ? formatAppSessionAwarenessBlock(
          loadAppSessionContext({
            path: this.config.appContextPath,
            cwd: params.cwd,
            sessionId: params.sessionId,
            fallback: params.appContext,
          }),
          {
            sessionId: params.sessionId,
            cwd: params.cwd,
            maxChars: Math.min(1800, Math.floor(this.config.recallMaxChars * 0.45)),
          },
        )
      : ''
    const remainingBudget = awarenessBlock
      ? Math.max(0, this.config.recallMaxChars - awarenessBlock.length - 1)
      : this.config.recallMaxChars

    const packed =
      remainingBudget >= 140
        ? packRecallBlock(allCandidates, {
            topK: this.config.recallTopK,
            maxChars: remainingBudget,
            fencedTag: params.fencedTag ?? 'evergreen_memory',
          })
        : { block: '', packed: [], charCount: 0, tokensInjected: 0 }

    const combinedBlock = [awarenessBlock, packed.block].filter(Boolean).join('\n')
    const combinedChars = combinedBlock.length
    const combinedTokens = combinedBlock ? estimateTokens(combinedBlock) : 0

    const latencyMs = Number((performance.now() - start).toFixed(2))
    const result               = {
      block: combinedBlock,
      items: packed.packed,
      cacheHit: false,
      latencyMs,
      charCount: combinedChars,
      tokensInjected: combinedTokens,
      mode: useKag && gbrainItems.some((g) => g.hopPath) ? 'kag-lite' : this.config.recallMethod,
    }

    this.cache.set(cacheKey, result)
    this.stats.recordRecall({
      cacheHit: false,
      latencyMs,
      tokensInjected: combinedTokens,
      estimatedBaselineTokens:
        params.unassistedBaselineTokens ?? Math.max(combinedTokens, combinedBlock ? 2200 : 0),
    })

    return result
  }

  /** Capture turn messages with secret redaction, opt-out check (Q-6), Q-14 daily write cap, & defer_extraction=true. */
  async capture(params   
                     
                
                      
                                                                                                                                                   
   )                                                                          {
    if (params.messages.length === 0) return { captured: 0, flushed: false }

    const combinedRaw = params.messages.map((m) => m.content).join('\n')
    if (isMemoryOptedOut({ cwd: params.cwd, text: combinedRaw })) {
      return { captured: 0, flushed: false, skippedReason: 'memory-off' }
    }

    if (!this.budgetGuard.canWrite(params.messages.length)) {
      this.stats.recordBudgetBlock()
      return { captured: 0, flushed: false, skippedReason: 'daily-budget-cap' }
    }

    let totalRedacted = 0
    const nowMs = Date.now()
    const sanitizedItems                = params.messages.map((m, idx) => {
      const red = redactSecrets(m.content)
      totalRedacted += red.redactedCount
      return {
        sender_id: sanitizeScopeId(m.senderId ?? (m.role === 'user' ? this.config.userId : this.config.agentId), m.role),
        role: m.role,
        timestamp: m.timestamp ?? nowMs + idx,
        content: red.text,
        ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id ?? `tc_${idx}` } : {}),
      }
    })

    const projectId = params.projectId ?? deriveProjectId(params.cwd)
    if (this.localIndex) {
      const liveDocs = sanitizedItems
        .map((sm, i) => ({
          id: `live:${params.sessionId}:${sm.timestamp}:${i}`,
          title: `Live DSH ${sm.role} turn`,
          text: sm.content.slice(0, 2400),
          project_id: projectId,
          app_id: this.config.appId,
          date: new Date(sm.timestamp).toISOString().slice(0, 10),
          source_tier: 2         ,
          owner_type: sm.role === 'user' ? ('user'         ) : ('agent'         ),
          tags: [params.sessionId, sm.role],
        }))
        .filter((d) => d.text.trim().length > 0)
      if (liveDocs.length > 0) this.localIndex.addDocuments(liveDocs)
    }

    try {
      await this.everos.add(
        {
          session_id: params.sessionId,
          app_id: this.config.appId,
          project_id: projectId,
          messages: sanitizedItems,
          defer_extraction: true,
        },
        this.config.captureTimeoutMs,
      )
    } catch {
      // Fail-open on active turns
      return { captured: 0, flushed: false, skippedReason: 'everos-unreachable' }
    }

    this.budgetGuard.consumeWrite(sanitizedItems.length)
    this.stats.recordCapture(sanitizedItems.length, totalRedacted)

    const tokenDelta = sanitizedItems.reduce((acc, m) => acc + estimateTokens(m.content), 0)
    const buf = this.sessionBuffers.get(params.sessionId) ?? {
      projectId,
      pendingMessages: 0,
      pendingTokens: 0,
      firstPendingAt: Date.now(),
    }
    buf.pendingMessages += sanitizedItems.length
    buf.pendingTokens += tokenDelta

    if (buf.idleTimer) clearTimeout(buf.idleTimer)

    const thresholdHit =
      buf.pendingMessages >= this.config.flushMessageThreshold ||
      buf.pendingTokens >= this.config.flushTokenThreshold ||
      (buf.firstPendingAt !== undefined && Date.now() - buf.firstPendingAt >= this.config.flushMaxDelayMs)

    if (thresholdHit) {
      this.sessionBuffers.set(params.sessionId, buf)
      await this.flushSession(params.sessionId)
      return { captured: sanitizedItems.length, flushed: true }
    }

    buf.idleTimer = setTimeout(() => {
      void this.flushSession(params.sessionId)
    }, this.config.flushIdleMs)
    ;(buf.idleTimer                          ).unref?.()
    if (!buf.maxTimer) {
      buf.maxTimer = setTimeout(() => {
        void this.flushSession(params.sessionId)
      }, this.config.flushMaxDelayMs)
      ;(buf.maxTimer                          ).unref?.()
    }
    this.sessionBuffers.set(params.sessionId, buf)
    return { captured: sanitizedItems.length, flushed: false }
  }

  async flushSession(sessionId        )                   {
    const buf = this.sessionBuffers.get(sessionId)
    if (buf?.idleTimer) clearTimeout(buf.idleTimer)
    if (buf?.maxTimer) clearTimeout(buf.maxTimer)
    const projectId = buf?.projectId ?? 'default'
    this.sessionBuffers.delete(sessionId)

    try {
      await this.everos.flush(
        {
          session_id: sessionId,
          app_id: this.config.appId,
          project_id: projectId,
        },
        this.config.captureTimeoutMs,
      )
      this.stats.recordFlush()
      return true
    } catch {
      return false
    }
  }

  async flushAllPending()                {
    const pendingIds = [...this.sessionBuffers.keys()]
    if (pendingIds.length === 0) return
    await Promise.allSettled(pendingIds.map((sid) => this.flushSession(sid)))
  }

  /** Compaction takeover (§5.7): summarizes cleanly in-process and captures durable checkpoint without an extra LLM call. */
  takeOverCompaction(params   
                     
                                                              
                                          
   )         {
    const redMsgs = params.messages.map((m) => ({
      role: m.role,
      content: redactSecrets(m.content).text,
    }))
    const summary = buildCompactionSummary({
      sessionId: params.sessionId,
      messages: redMsgs,
      recalled: params.recalled,
    })
    this.stats.recordCompactionTakeover()
    return summary
  }

  /** Approval-gated EverOS -> GBrain promotion bridge (Q-3). Never auto-writes GBrain without explicit `approved: true`. */
  proposePromotion(candidate                                    )                     {
    const redTitle = redactSecrets(candidate.title).text
    const redContent = redactSecrets(candidate.content).text
    const item                     = {
      ...candidate,
      title: redTitle,
      content: redContent,
      status: 'pending',
    }
    this.pendingPromotions.set(item.id, item)
    this.stats.recordPromotionQueued()
    return item
  }

  async approvePromotion(candidateId        , approved         )                                                                            {
    const item = this.pendingPromotions.get(candidateId)
    if (!item) return { status: 'not_found' }
    if (!approved) {
      item.status = 'rejected'
      return { status: 'rejected' }
    }
    if (!this.budgetGuard.canWrite(1)) {
      this.stats.recordBudgetBlock()
      throw new Error('Daily write budget cap reached (Q-14); GBrain promotion blocked fail-closed.')
    }
    const slug = `${item.pageType}s/${sanitizeScopeId(item.id, 'promotion')}`
    const res = await this.gbrain.putPage(
      {
        id: slug,
        type: item.pageType,
        title: item.title,
        summary: `${item.content}\n\nProvenance: app=${item.provenance.appId} project=${item.provenance.projectId} session=${item.provenance.sessionId} at=${item.provenance.createdAt}`,
        date: item.provenance.createdAt.slice(0, 10),
        project_id: item.provenance.projectId,
        source_tier: 1,
      },
      item.edges ?? [],
    )
    this.budgetGuard.consumeWrite(1)
    item.status = 'approved'
    this.stats.recordPromotionApproved()
    return { status: 'approved', slug: res.slug }
  }

  listPendingPromotions()                       {
    return [...this.pendingPromotions.values()].filter((p) => p.status === 'pending')
  }

  getStats()                      {
    return this.stats.snapshot()
  }

  formatStatsReport()         {
    const s = this.getStats()
    const pctSaved =
      s.estimatedTokensBaseline > 0
        ? ((s.estimatedTokensSaved / s.estimatedTokensBaseline) * 100).toFixed(1)
        : '0.0'
    return [
      `Memory Stats (${this.config.appId} | mode=${this.config.recallMethod}${this.config.enableKagLite ? '+kag-lite' : ''}):`,
      `- Recall calls: ${s.recallCalls} (cache hits: ${s.cacheHits}, avg latency: ${s.avgRecallLatencyMs} ms)`,
      `- Capture: ${s.captureMessages} msgs in ${s.deferredAdds} deferred batches, ${s.flushCalls} flushes, ${s.redactedSecretsCount} secrets redacted`,
      `- Compaction bypasses: ${s.compactionCallsSaved} LLM calls skipped`,
      `- Promotions (Q-3): ${s.promotionsApproved}/${s.promotionsQueued} approved | Budget blocks (Q-14): ${s.dailyWritesBlockedByBudget}`,
      `- Token efficiency: ${s.estimatedTokensInjected} injected vs ${s.estimatedTokensBaseline} unassisted baseline (${pctSaved}% saved)`,
    ].join('\n')
  }

  dispose()       {
    for (const buf of this.sessionBuffers.values()) {
      if (buf.idleTimer) clearTimeout(buf.idleTimer)
      if (buf.maxTimer) clearTimeout(buf.maxTimer)
    }
    this.sessionBuffers.clear()
  }
}
