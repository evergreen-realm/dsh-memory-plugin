/**
 * Ollama Pro Web Search/Fetch providers + Clef SystemOne Research Advisor + Kimi Claw multi-stage research pipeline.
 * Runs exclusively on a single OLLAMA_API_KEY, enforcing Pro's 3-concurrent-request limit via a shared semaphore.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactSecrets } from './core/index.js'

export const OLLAMA_BASE_URL = 'https://ollama.com'
export const OLLAMA_DEFAULT_MAX_CONCURRENT = 3
export const OLLAMA_WEB_MODELS = {
  primaryFallback: 'deepseek-v4.1-flash',
  budgetFallback: 'glm-5.3-flash',
  fastFallback: 'minimax-m3.1-flash',
  advisor: 'clef',
  synthesis: 'kimi-k2.7-code',
  synthesisAlt: 'kimi-k2.6',
}         

export const ORDERED_FALLBACK_CHAIN = [
  { provider: 'ollama', model: OLLAMA_WEB_MODELS.primaryFallback, maxContextTokens: 1_000_000 },
  { provider: 'ollama', model: OLLAMA_WEB_MODELS.budgetFallback, maxContextTokens: 1_000_000 },
  { provider: 'ollama', model: OLLAMA_WEB_MODELS.fastFallback, maxContextTokens: 976_000 },
]         

                                  
             
                
                  
                  
                      
 

                                       
                  
                            
                    
 

                                      
             
                    
                                                  
                    
 

                                     
                                       
              
                            
                                                                 
                                                                                                                
                           
                                      
              
                            
                                                                 
                                                                                       
                           
 

                                    
               
                                                                           
                            
                          
                           
                     
                
 

                                      
               
                             
                                     
                          
                                                           
                                                 
                       
 

                                     
               
                                    
                      
                                 
                      
               
                                                                                   
 

/** Shared semaphore capping concurrent Ollama Cloud HTTP requests (Pro tier = 3 concurrent slots). */
export class AsyncSemaphore {
          active = 0
                   queue                    = []
                   maxConcurrent        

  constructor(maxConcurrent = OLLAMA_DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = Math.max(1, maxConcurrent)
  }

  get inFlight()         {
    return this.active
  }

  async run   (fn                  , signal              )             {
    if (signal?.aborted) throw new Error('Aborted before acquiring Ollama concurrency slot')
    if (this.active >= this.maxConcurrent) {
      await new Promise      ((resolve, reject) => {
        const onAbort = () => {
          const idx = this.queue.indexOf(releaseWaiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new Error('Aborted while waiting for Ollama concurrency slot'))
        }
        const releaseWaiter = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.queue.push(releaseWaiter)
      })
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

export function isPrivateOrLoopbackUrl(rawUrl        )          {
  let parsed     
  try {
    parsed = new URL(rawUrl)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^169\.254\./u.test(host)) return true
  const m172 = host.match(/^172\.(\d+)\./u)
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true
  if (/^192\.168\./u.test(host)) return true
  return false
}

export function readOllamaKeyFromDshCredentials(dshHome         )                     {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const credPath = join(home, '.credentials.yaml')
  if (!existsSync(credPath)) return undefined
  try {
    const raw = readFileSync(credPath, 'utf8')
    const match = raw.match(/(?:^|\n)\s*OLLAMA_API_KEY:\s*["']?([^\s"'#]+)["']?/u)
    return match?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

export async function resolveOllamaApiKey(opts   
                      
                  
                                                                                             
  = {})                              {
  if (opts.explicitKey?.trim()) return opts.explicitKey.trim()
  if (opts.credentialsService?.resolve) {
    try {
      const hit = await opts.credentialsService.resolve('OLLAMA_API_KEY')
      if (hit?.value?.trim()) return hit.value.trim()
    } catch {
      // Fall through to env / local credentials yaml
    }
  }
  const envKey = process.env.OLLAMA_API_KEY?.trim()
  if (envKey) return envKey
  return readOllamaKeyFromDshCredentials(opts.dshHome)
}

async function ollamaPostJson   (opts   
                  
              
                
                               
                           
                        
                    
                      
                     
 )             {
  const base = (opts.baseUrl || OLLAMA_BASE_URL).replace(/\/+$/u, '')
  const url = `${base}${opts.path}`
  const fetchImpl = opts.fetchFn ?? fetch
  const retries = opts.maxRetries ?? 2

  return opts.semaphore.run(async () => {
    let lastErr         
    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 20_000)
      const combined = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(opts.body),
          signal: combined,
        })
        if (res.status === 429 || res.status >= 500) {
          const txt = await res.text().catch(() => '')
          lastErr = new Error(`Ollama ${opts.path} HTTP ${res.status}: ${redactSecrets(txt).text.slice(0, 180)}`)
          if (attempt < retries) {
            const jitter = 350 + Math.floor(Math.random() * 400)
            await new Promise((r) => setTimeout(r, jitter * (attempt + 1)))
            continue
          }
          throw lastErr
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(`Ollama ${opts.path} HTTP ${res.status}: ${redactSecrets(txt).text.slice(0, 180)}`)
        }
        return (await res.json())     
      } catch (err) {
        lastErr = err
        if (opts.signal?.aborted || attempt >= retries) throw err
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }, opts.signal)
}

async function ollamaChatText(opts   
                  
                
               
                
              
                    
                           
                        
                    
                      
 )                  {
  const payload = await ollamaPostJson  
                                                       
    ({
    baseUrl: opts.baseUrl,
    path: '/v1/chat/completions',
    apiKey: opts.apiKey,
    semaphore: opts.semaphore,
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs ?? 45_000,
    signal: opts.signal,
    body: {
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      temperature: 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    },
  })
  return payload.choices?.[0]?.message?.content?.trim() ?? ''
}

export async function ollamaWebSearch(opts   
               
                     
                
                  
                           
                        
                    
                      
 )                                {
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 8, 10))
  const data = await ollamaPostJson  
                                                                                         
    ({
    baseUrl: opts.baseUrl,
    path: '/api/web_search',
    apiKey: opts.apiKey,
    semaphore: opts.semaphore,
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
    body: { query: opts.query, max_results: maxResults },
  })

  const raw = Array.isArray(data.results) ? data.results : []
  const sources                    = raw
    .filter((r) => typeof r.url === 'string' && r.url.trim().length > 0)
    .slice(0, maxResults)
    .map((r) => ({
      url: r.url .trim(),
      title: r.title?.trim() || r.url .trim(),
      snippet: redactSecrets((r.content ?? r.snippet ?? '').replace(/\s+/gu, ' ').trim()).text.slice(0, 750),
    }))

  const content = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.snippet}`)
    .join('\n\n')
    .slice(0, 12_000)

  return {
    content: content || `No results returned for "${opts.query}".`,
    sources,
    truncated: raw.length > maxResults,
  }
}

export async function ollamaWebFetch(opts   
             
                
                  
                           
                        
                    
                      
 )                               {
  if (isPrivateOrLoopbackUrl(opts.url)) {
    throw new Error(`Blocked non-public or loopback URL in web_fetch: ${opts.url}`)
  }
  const data = await ollamaPostJson  
                  
                    
                    
    ({
    baseUrl: opts.baseUrl,
    path: '/api/web_fetch',
    apiKey: opts.apiKey,
    semaphore: opts.semaphore,
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs ?? 20_000,
    signal: opts.signal,
    body: { url: opts.url },
  })
  const cleanTitle = (data.title ?? '').trim()
  const bodyContent = redactSecrets((data.content ?? '').trim()).text
  const linksBlock =
    Array.isArray(data.links) && data.links.length > 0
      ? `\n\n---\nExtracted Links:\n${data.links.slice(0, 20).map((l) => `- ${l}`).join('\n')}`
      : ''
  const combined = `${cleanTitle ? `# ${cleanTitle}\nURL: ${opts.url}\n\n` : ''}${bodyContent}${linksBlock}`.trim()
  const capped = combined.length > 180_000 ? `${combined.slice(0, 180_000)}\n...[truncated]` : combined
  return {
    url: opts.url,
    statusCode: 200,
    body: { kind: 'text', content: capped },
    truncated: combined.length > 180_000,
  }
}

/**
 * Call Clef via /v1/systemone (0 output tokens) to filter URLs and pick the lowest-cost research tier.
 * Enforces Clef Cloud's 64K token ceiling by inspecting only compact snippets (~<=48K chars).
 */
export async function consultClefAdvisor(opts   
               
                                        
                
                  
                           
                        
                      
 )                             {
  const cappedCandidates = opts.candidates.slice(0, 10)
  if (cappedCandidates.length === 0) {
    return {
      used: false,
      routeTier: 'snippet_sufficient',
      evidenceSufficient: 0,
      conflictDetected: 0,
      selectedIndices: [],
      inputTokens: 0,
    }
  }

  const stateObj = {
    query: opts.query.slice(0, 1200),
    candidates: cappedCandidates.map((c, idx) => ({
      idx,
      url: c.url,
      title: (c.title ?? '').slice(0, 180),
      snippet: (c.snippet ?? '').slice(0, 500),
    })),
  }

  const questions                          = {
    route_tier: {
      type: 'choice',
      instructions: 'Pick the lowest-cost research action needed after reviewing snippets.',
      criteria: {
        snippet_sufficient: 'The snippets already contain a direct, trustworthy answer.',
        fetch_top_urls: 'Full page fetching and fast Flash extraction are needed for specifics.',
        escalate_kimi_k2_7: 'Complex, conflicting, or multi-source synthesis is needed.',
      },
    },
    evidence_sufficient: {
      type: 'noul',
      instructions: 'Do the search snippets alone completely and reliably answer the query?',
    },
    conflict_detected: {
      type: 'noul',
      instructions: 'Do the candidates contain conflicting facts or require cross-source reconciliation?',
    },
  }
  for (let i = 0; i < cappedCandidates.length; i++) {
    questions[`url_useful_${i}`] = {
      type: 'noul',
      instructions: `Should candidate idx=${i} be fetched for authoritative primary technical details?`,
    }
  }

  try {
    const res = await ollamaPostJson  
                                                                  
                                       
      ({
      baseUrl: opts.baseUrl,
      path: '/v1/systemone',
      apiKey: opts.apiKey,
      semaphore: opts.semaphore,
      fetchFn: opts.fetchFn,
      timeoutMs: 12_000,
      signal: opts.signal,
      body: {
        model: OLLAMA_WEB_MODELS.advisor,
        state: stateObj,
        questions,
      },
    })

    const ans = res.answers ?? {}
    const rawTier = ans.route_tier?.choice
    const routeTier                                 =
      rawTier === 'snippet_sufficient' || rawTier === 'escalate_kimi_k2_7' ? rawTier : 'fetch_top_urls'
    const evidenceSufficient = typeof ans.evidence_sufficient?.noul === 'number' ? ans.evidence_sufficient.noul : 0
    const conflictDetected = typeof ans.conflict_detected?.noul === 'number' ? ans.conflict_detected.noul : 0

    const rankedIndices = cappedCandidates
      .map((_, i) => ({
        i,
        prob: typeof ans[`url_useful_${i}`]?.noul === 'number' ? ans[`url_useful_${i}`] .noul  : 0,
      }))
      .sort((a, b) => b.prob - a.prob)

    const chosen = rankedIndices.filter((r) => r.prob >= 0.55).map((r) => r.i)
    const selectedIndices = chosen.length > 0 ? chosen : rankedIndices.slice(0, 3).map((r) => r.i)

    return {
      used: true,
      routeTier,
      evidenceSufficient,
      conflictDetected,
      selectedIndices,
      inputTokens: res.usage?.input_tokens ?? 0,
    }
  } catch (err) {
    // Fail-open cleanly to top-3 URLs if /v1/systemone is unreachable
    return {
      used: false,
      routeTier: 'fetch_top_urls',
      evidenceSufficient: 0,
      conflictDetected: 0,
      selectedIndices: cappedCandidates.slice(0, 3).map((_, i) => i),
      inputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function runKimiClawDeepResearch(
  options                     ,
  runtime   
                  
                    
                              
                          
                        
   ,
)                              {
  const mode = options.mode ?? 'balanced'
  const semaphore = runtime.semaphore ?? new AsyncSemaphore(OLLAMA_DEFAULT_MAX_CONCURRENT)
  const compressionModel =
    options.compressionModel ?? (mode === 'fast' ? OLLAMA_WEB_MODELS.fastFallback : OLLAMA_WEB_MODELS.budgetFallback)
  const synthesisModel = options.synthesisModel ?? OLLAMA_WEB_MODELS.synthesis
  const modelsUsed = new Set        ()

  // Stage 1: Focused query expansion
  let queries = [...(options.queries ?? [])].map((q) => q.trim()).filter(Boolean)
  if (queries.length === 0) {
    queries = [options.query.trim()]
    if (mode !== 'fast') {
      try {
        const exp = await ollamaChatText({
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
          model: compressionModel,
          semaphore,
          fetchFn: runtime.fetchFn,
          timeoutMs: 12_000,
          signal: runtime.signal,
          maxTokens: 160,
          system: 'Return ONLY a JSON array of 2 concise complementary web search queries. No markdown.',
          user: options.query,
        })
        modelsUsed.add(compressionModel)
        const parsed = JSON.parse(exp.replace(/```json|```/gu, '').trim())           
        if (Array.isArray(parsed)) {
          for (const q of parsed) {
            if (typeof q === 'string' && q.trim() && !queries.includes(q.trim())) queries.push(q.trim())
          }
        }
      } catch {
        // Ignore expansion errors and keep primary query
      }
    }
  }
  queries = queries.slice(0, 3)

  // Stage 2: Parallel search via Ollama Cloud web_search + URL dedupe
  const searchBatches = await Promise.all(
    queries.map((q) =>
      ollamaWebSearch({
        query: q,
        maxResults: 8,
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        semaphore,
        fetchFn: runtime.fetchFn,
        signal: runtime.signal,
      }).catch(() => ({ sources: [], truncated: false })),
    ),
  )

  const deduped                    = []
  const seenUrls = new Set        ()
  for (const batch of searchBatches) {
    for (const s of batch.sources) {
      if (seenUrls.has(s.url)) continue
      seenUrls.add(s.url)
      deduped.push(s)
    }
  }

  // Stage 3: Clef Advisor Gatekeeper (zero output tokens)
  const clefDecision                    =
    options.useClefAdvisor === false
      ? {
          used: false,
          routeTier: mode === 'deep' ? 'escalate_kimi_k2_7' : 'fetch_top_urls',
          evidenceSufficient: 0,
          conflictDetected: 0,
          selectedIndices: deduped.slice(0, options.maxFetchUrls ?? 4).map((_, i) => i),
          inputTokens: 0,
        }
      : await consultClefAdvisor({
          query: options.query,
          candidates: deduped,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          semaphore,
          fetchFn: runtime.fetchFn,
          signal: runtime.signal,
        })
  if (clefDecision.used) modelsUsed.add(OLLAMA_WEB_MODELS.advisor)

  // Fast exit when Clef confirms snippets already suffice
  if (mode !== 'deep' && clefDecision.routeTier === 'snippet_sufficient' && clefDecision.evidenceSufficient >= 0.8) {
    const topSnippets = deduped.slice(0, 6)
    const brief = [
      `## Cited Quick Research Brief (Clef Snippet-Sufficient Gate: ${(clefDecision.evidenceSufficient * 100).toFixed(0)}%)`,
      ...topSnippets.map((s, idx) => `${idx + 1}. **[${s.title}](${s.url})** — ${s.snippet}`),
    ].join('\n\n')
    return {
      query: options.query,
      mode,
      queriesRun: queries,
      clefDecision,
      modelsUsed: [...modelsUsed],
      brief,
      sources: topSnippets.map((s) => ({
        url: s.url,
        title: s.title ?? s.url,
        fetched: false,
        snippet: s.snippet ?? '',
      })),
    }
  }

  // Stage 4: Bounded web_fetch + Flash passage compression
  const fetchLimit = Math.max(1, Math.min(options.maxFetchUrls ?? 4, 5))
  const pickIdx = clefDecision.selectedIndices.slice(0, fetchLimit)
  const targets = pickIdx.map((i) => deduped[i]).filter((x)                       => Boolean(x))

  const fetchedPages = await Promise.all(
    targets.map(async (target) => {
      try {
        const fetched = await ollamaWebFetch({
          url: target.url,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          semaphore,
          fetchFn: runtime.fetchFn,
          signal: runtime.signal,
        })
        const rawText = fetched.body.content.slice(0, 28_000)
        const extracted = await ollamaChatText({
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
          model: compressionModel,
          semaphore,
          fetchFn: runtime.fetchFn,
          maxTokens: 750,
          signal: runtime.signal,
          system:
            'Extract only verifiable facts, numbers, APIs, dates, and code relevant to the query in tight bullet points. Cite exact inline URL.',
          user: `Query: ${options.query}\nSource: ${target.title} (${target.url})\n\nContent:\n${rawText}`,
        })
        modelsUsed.add(compressionModel)
        return { url: target.url, title: target.title ?? target.url, fetched: true, extract: extracted || target.snippet || '' }
      } catch {
        return { url: target.url, title: target.title ?? target.url, fetched: false, extract: target.snippet ?? '' }
      }
    }),
  )

  const combinedExtracts = fetchedPages
    .map((p, i) => `### [${i + 1}] ${p.title} (${p.url})\n${p.extract}`)
    .join('\n\n')
    .slice(0, 160_000)

  const needsKimi =
    mode === 'deep' || clefDecision.routeTier === 'escalate_kimi_k2_7' || clefDecision.conflictDetected >= 0.65

  let finalBrief = combinedExtracts
  if (needsKimi && combinedExtracts.trim()) {
    try {
      const synth = await ollamaChatText({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        model: synthesisModel,
        semaphore,
        fetchFn: runtime.fetchFn,
        timeoutMs: 60_000,
        maxTokens: 2048,
        signal: runtime.signal,
        system:
          'Synthesize a concise, factual engineering/research brief from ONLY the verified source extracts. Preserve inline markdown citations [Title](url) and note any contradictions.',
        user: `Question: ${options.query}\n\nVerified Source Extracts:\n${combinedExtracts}`,
      })
      if (synth) {
        modelsUsed.add(synthesisModel)
        finalBrief = synth
      }
    } catch {
      // Keep compressed Flash extracts as grounded fallback
    }
  }

  return {
    query: options.query,
    mode,
    queriesRun: queries,
    clefDecision,
    modelsUsed: [...modelsUsed],
    brief: finalBrief,
    sources: fetchedPages.map((p) => ({
      url: p.url,
      title: p.title,
      fetched: p.fetched,
      snippet: p.extract.slice(0, 500),
    })),
  }
}

export function registerOllamaWebProviders(
  webRegistry                    ,
  options   
                    
                   
                    
                                                                                               
                              
                          
                                                                      
    = {},
)             {
  const semaphore = options.semaphore ?? new AsyncSemaphore(OLLAMA_DEFAULT_MAX_CONCURRENT)
  const disposers                    = []

  const getKey = () =>
    resolveOllamaApiKey({
      explicitKey: options.apiKey,
      dshHome: options.dshHome,
      credentialsService: options.credentialsService,
    })

  if (typeof webRegistry.registerSearchProvider === 'function') {
    const d = webRegistry.registerSearchProvider({
      id: 'ollama-kimi',
      available: () => true,
      ready: async () => Boolean(await getKey()),
      search: async (req, signal) => {
        const apiKey = await getKey()
        if (!apiKey) throw new Error('OLLAMA_API_KEY is not configured in ~/.dsh/.credentials.yaml or environment')
        const res = await ollamaWebSearch({
          query: req.query,
          maxResults: req.maxResults,
          apiKey,
          baseUrl: options.baseUrl,
          semaphore,
          fetchFn: options.fetchFn,
          signal,
        })
        options.onLog?.('web_search_ollama', { queryLength: req.query.length, sourceCount: res.sources.length })
        return res
      },
    })
    if (typeof d === 'function') disposers.push(d)
  }

  if (typeof webRegistry.registerFetchProvider === 'function') {
    const d = webRegistry.registerFetchProvider({
      id: 'ollama-fetch',
      available: () => true,
      ready: async () => Boolean(await getKey()),
      fetch: async (req, signal) => {
        const apiKey = await getKey()
        if (!apiKey) throw new Error('OLLAMA_API_KEY is not configured in ~/.dsh/.credentials.yaml or environment')
        const res = await ollamaWebFetch({
          url: req.url,
          apiKey,
          baseUrl: options.baseUrl,
          semaphore,
          fetchFn: options.fetchFn,
          signal,
        })
        options.onLog?.('web_fetch_ollama', { contentChars: res.body.content.length, truncated: res.truncated })
        return res
      },
    })
    if (typeof d === 'function') disposers.push(d)
  }

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // Ignore disposer failure
      }
    }
  }
}
