/** Keyword (BM25+identifier), Vector cosine (Ollama/OpenAI or deterministic projection), & RRF Hybrid retrieval (§5.5). */

import { createHash } from 'node:crypto'

                                                         
             
             
              
               
                
              
                
               
                 
                   

                             
            
               
              
                     
                 
               
                         
                              
                 
                      
 

                               
                 
               
                      
                     
 

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'what', 'which', 'who', 'how', 'when', 'where', 'why', 'did', 'do', 'we', 'i', 'you', 'it', 'that', 'this',
])

/** Concept alias expansion maps natural-language paraphrases & domain concepts to normalized semantic axes. */
const SEMANTIC_CONCEPT_CLUSTERS                                   = [
  ['token', 'cost', 'credit', 'budget', 'spend', 'billing', 'quota', 'pricing', 'usage', 'efficiency', 'cap', 'limit', 'ceiling', 'cache', 'ttl', 'char'],
  ['memory', 'recall', 'remember', 'context', 'episode', 'memcell', 'memscene', 'everos', 'mag', 'flush', 'defer', 'extract', 'batch', 'idle', 'timer', 'queue', 'delay', 'async'],
  ['graph', 'kag', 'hop', 'multi-hop', 'entity', 'edge', 'relation', 'bfs', 'walk', 'kuzu', 'openspg', 'schema'],
  ['search', 'retrieval', 'hybrid', 'rrf', 'vector', 'embedding', 'keyword', 'bm25', 'rank', 'cosine', 'semantic'],
  ['compaction', 'summarize', 'summary', 'checkpoint', 'shrink', 'truncate', 'autocontinue'],
  ['redact', 'secret', 'token', 'key', 'oauth', 'hf_token', 'credential', 'leak', 'security', 'sanitize'],
  ['codespace', 'lonely-tomb', 'devcontainer', 'docker', 'alpine', 'recovery', 'tunnel', 'ssh', 'port'],
  ['kaggle', 'gpu', 't4', 'tpu', 'offload', 'dispatcher', 'batch', 'compute', 'accelerator'],
  ['gbrain', 'pglite', 'postgres', 'pgvector', 'pg_notify', 'mcp', 'zipbomb', 'bundle'],
  ['opencode', 'dsh', 'deepseek', 'harness', 'cordis', 'plugin', 'desktop', 'creator'],
  ['antigravity', 'sync', 'drive', 'isolated', 'separate', 'obsidian', 'vault', 'session_v2', 'sqlite'],
  ['decision', 'locked', 'gate', 'approved', 'approval', 'promote', 'bridge', 'option', 'escalate'],
  ['prefix', 'kv', 'prepend', 'append', 'bottom', 'ordering', 'static', 'dynamic', 'instructions'],
  ['ram', 'laptop', 'windows', 'local', 'cloud', 'heavyweight', 'thin', 'oom', 'split', '32gb', '7gb'],
]

export function tokenizeText(text        )           {
  const raw = text.toLowerCase().split(/[^a-z0-9_.:/-]+/).filter(Boolean)
  const out           = []
  for (const tok of raw) {
    if (tok.length <= 1 || STOPWORDS.has(tok)) continue
    out.push(tok)
    // Also split compound identifiers like gbrain_bundle.zip, :3131, KAG-lite so sub-tokens match
    if (/[_.:/-]/.test(tok)) {
      for (const part of tok.split(/[_.:/-]+/)) {
        if (part.length > 1 && !STOPWORDS.has(part)) out.push(part)
      }
    }
  }
  return out
}

/** Deterministic 192-d semantic + char-trigram projection for fast zero-API local/CI vector benchmarks. */
export function localSemanticEmbed(text        , dim = 192)           {
  const vec = new Float64Array(dim)
  const lower = text.toLowerCase()
  const tokens = tokenizeText(lower)

  // 1. Word hash dimensions
  for (const tok of tokens) {
    const h = createHash('sha256').update(`w:${tok}`).digest()
    const idx1 = h.readUInt16BE(0) % dim
    const idx2 = h.readUInt16BE(2) % dim
    const s1 = (h[4] & 1) === 0 ? 1 : -1
    const s2 = (h[5] & 1) === 0 ? 1 : -1
    vec[idx1] += 1.0 * s1
    vec[idx2] += 0.65 * s2

    // 2. Inject semantic concept cluster dimensions so synonyms/paraphrases align cleanly
    for (let c = 0; c < SEMANTIC_CONCEPT_CLUSTERS.length; c += 1) {
      const cluster = SEMANTIC_CONCEPT_CLUSTERS[c]
      if (cluster.some((kw) => tok.includes(kw) || kw.includes(tok))) {
        const cBucket = (c * 13 + 7) % dim
        vec[cBucket] += 1.8
        vec[(cBucket + 5) % dim] += 1.2
      }
    }
  }

  // 3. Signed low-weight char 3-gram surface robustness without positive orthant skew
  const compact = lower.replace(/\s+/g, ' ').trim()
  for (let i = 0; i <= compact.length - 3; i += 1) {
    const tri = compact.slice(i, i + 3)
    const h = createHash('md5').update(tri).digest()
    const idx = h.readUInt16BE(0) % dim
    const sign = (h[2] & 1) === 0 ? 1 : -1
    vec[idx] += 0.06 * sign
  }

  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  const normalized           = new Array(dim)
  for (let i = 0; i < dim; i += 1) normalized[i] = vec[i] / norm
  return normalized
}

export function cosineSimilarity(a                   , b                   )         {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Optional live Ollama/OpenAI embedder that falls back cleanly to localSemanticEmbed offline. */
export async function embedText(
  text        ,
  opts                                                             ,
)                    {
  if (opts?.ollamaUrl) {
    try {
      const res = await fetch(`${opts.ollamaUrl.replace(/\/+$/u, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model ?? 'nomic-embed-text', prompt: text }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      })
      if (res.ok) {
        const data = (await res.json())                            
        if (Array.isArray(data.embedding) && data.embedding.length > 0) return data.embedding
      }
    } catch {
      // Fall back to deterministic semantic embedding
    }
  }
  return localSemanticEmbed(text)
}

export class HybridRetrievalIndex {
          docs               = []
          df = new Map                ()
          avgLen = 1

  constructor(initialDocs                        = []) {
    if (initialDocs.length > 0) this.addDocuments(initialDocs)
  }

  addDocuments(docs                       )       {
    const idToIdx = new Map                ()
    for (let i = 0; i < this.docs.length; i++) {
      idToIdx.set(this.docs[i] .id, i)
    }
    for (const d of docs) {
      const emb = d.embedding ?? localSemanticEmbed(`${d.title} ${d.text} ${(d.tags ?? []).join(' ')}`)
      const docWithEmb             = { ...d, embedding: emb }
      const existingIdx = idToIdx.get(d.id)
      if (existingIdx !== undefined) {
        this.docs[existingIdx] = docWithEmb
      } else {
        idToIdx.set(d.id, this.docs.length)
        this.docs.push(docWithEmb)
      }
    }
    this.rebuildStats()
  }

  size()         {
    return this.docs.length
  }

          rebuildStats()       {
    this.df.clear()
    let totalLen = 0
    for (const d of this.docs) {
      const toks = tokenizeText(`${d.title} ${d.text} ${(d.tags ?? []).join(' ')}`)
      totalLen += toks.length
      const unique = new Set(toks)
      for (const u of unique) {
        this.df.set(u, (this.df.get(u) ?? 0) + 1)
      }
    }
    this.avgLen = this.docs.length > 0 ? Math.max(1, totalLen / this.docs.length) : 1
  }

  searchKeyword(query        , opts                                                  = {})                 {
    const qTokens = tokenizeText(query)
    if (qTokens.length === 0) return []
    const N = Math.max(1, this.docs.length)
    const exactIdTokens = (query.match(/(?::\d{2,5}|[a-z0-9]+_[a-z0-9_]+|[A-Z]{2,}[A-Z0-9_-]*|ses_[A-Za-z0-9]+|q-\d+)/gi) ?? []).map(
      (s) => s.toLowerCase(),
    )

    const k1 = 1.5
    const b = 0.75
    const scored                 = []

    for (const d of this.docs) {
      if (opts.ownerType && d.owner_type !== opts.ownerType) continue
      const fullText = `${d.title} ${d.text} ${(d.tags ?? []).join(' ')}`
      const docTokens = tokenizeText(fullText)
      const dl = docTokens.length || 1
      const tfMap = new Map                ()
      for (const t of docTokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1)

      let bm25 = 0
      for (const qt of qTokens) {
        const tf = tfMap.get(qt) ?? 0
        if (tf === 0) continue
        const df = this.df.get(qt) ?? 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / this.avgLen))))
      }

      const lowerFull = fullText.toLowerCase()
      for (const ex of exactIdTokens) {
        if (lowerFull.includes(ex)) bm25 += 2.2
      }

      if (bm25 > 0) {
        const tierBoost = d.source_tier === 1 ? 1.12 : d.source_tier === 2 ? 1.0 : 0.92
        scored.push({ doc: d, score: bm25 * tierBoost })
      }
    }

    scored.sort((a, b2) => b2.score - a.score)
    return scored.slice(0, opts.topK ?? 5).map((h, i) => ({ ...h, keywordRank: i + 1 }))
  }

  searchVector(query        , opts                                                                             = {})                 {
    const qEmb = opts.queryEmbedding ?? localSemanticEmbed(query)
    const scored                 = []
    for (const d of this.docs) {
      if (opts.ownerType && d.owner_type !== opts.ownerType) continue
      if (!d.embedding) continue
      const sim = cosineSimilarity(qEmb, d.embedding)
      if (sim > 0.05) {
        const tierBoost = d.source_tier === 1 ? 1.08 : d.source_tier === 2 ? 1.0 : 0.94
        scored.push({ doc: d, score: sim * tierBoost })
      }
    }
    scored.sort((a, b2) => b2.score - a.score)
    return scored.slice(0, opts.topK ?? 5).map((h, i) => ({ ...h, vectorRank: i + 1 }))
  }

  /** Reciprocal Rank Fusion (RRF, k = 60) over keyword + vector arms. */
  searchHybridRRF(
    query        ,
    opts                                                                                       = {},
  )                 {
    const topK = opts.topK ?? 5
    const rrfK = opts.rrfK ?? 30
    const pool = opts.armPoolSize ?? Math.min(12, Math.max(8, topK * 2))

    const kwHits = this.searchKeyword(query, { topK: pool, ownerType: opts.ownerType })
    const vecHits = this.searchVector(query, { topK: pool, ownerType: opts.ownerType })

    const byId = new Map                      ()
    kwHits.forEach((h, idx) => {
      const rank = idx + 1
      const vote = 1 / (rrfK + rank)
      byId.set(h.doc.id, { doc: h.doc, score: vote, keywordRank: rank })
    })

    vecHits.forEach((h, idx) => {
      const rank = idx + 1
      const vote = 1 / (rrfK + rank)
      const prev = byId.get(h.doc.id)
      if (prev) {
        prev.score += vote
        prev.vectorRank = rank
      } else {
        byId.set(h.doc.id, { doc: h.doc, score: vote, vectorRank: rank })
      }
    })

    const merged = [...byId.values()].map((h) => {
      const tierBoost = h.doc.source_tier === 1 ? 1.08 : h.doc.source_tier === 2 ? 1.0 : 0.95
      // Scale RRF votes cleanly into readable ~0..1 band while preserving strict ordering
      return { ...h, score: Number((h.score * 30 * tierBoost).toFixed(6)) }
    })

    merged.sort((a, b) => b.score - a.score)
    return merged.slice(0, topK)
  }

  search(query        , method               = 'hybrid', opts                                                  = {})                 {
    if (method === 'keyword') return this.searchKeyword(query, opts)
    if (method === 'vector') return this.searchVector(query, opts)
    return this.searchHybridRRF(query, opts)
  }
}

/** In-memory EverOS API v2 server simulator preserving the exact `/api/v2/memory/*` contract for offline tests & A/B eval. */
export class InMemoryEverosEngine                            {
           index = new HybridRetrievalIndex()
                   bufferBySession = new Map                                                                           ()
         flushCount = 0

  constructor(initialDocs                        = []) {
    if (initialDocs.length > 0) this.index.addDocuments(initialDocs)
  }

  async health()                              {
    return { status: 'ok' }
  }

  async add(req            )                       {
    const entry = this.bufferBySession.get(req.session_id) ?? {
      project_id: req.project_id,
      app_id: req.app_id,
      messages: [],
    }
    entry.messages.push(...req.messages)
    this.bufferBySession.set(req.session_id, entry)

    if (req.defer_extraction === false) {
      await this.flush({ session_id: req.session_id, app_id: req.app_id, project_id: req.project_id })
      return { message_count: req.messages.length, status: 'extracted' }
    }
    return { message_count: req.messages.length, status: 'accumulated' }
  }

  async flush(req              )                         {
    const entry = this.bufferBySession.get(req.session_id)
    if (!entry || entry.messages.length === 0) {
      return { status: 'no_extraction' }
    }
    const combined = entry.messages.map((m) => `${m.role}: ${m.content}`).join('\n')
    const userPart = entry.messages.filter((m) => m.role === 'user').map((m) => m.content).join(' | ')
    const agentPart = entry.messages.filter((m) => m.role !== 'user').map((m) => m.content).join(' | ')

    const docs               = []
    if (userPart) {
      docs.push({
        id: `ep-user-${req.session_id}-${this.flushCount}`,
        title: `Session ${req.session_id} User Episode`,
        text: userPart,
        project_id: req.project_id ?? entry.project_id,
        app_id: req.app_id ?? entry.app_id,
        owner_type: 'user',
        source_tier: 1,
      })
    }
    if (agentPart || combined) {
      docs.push({
        id: `ep-agent-${req.session_id}-${this.flushCount}`,
        title: `Session ${req.session_id} Agent Episode`,
        text: agentPart || combined,
        project_id: req.project_id ?? entry.project_id,
        app_id: req.app_id ?? entry.app_id,
        owner_type: 'agent',
        source_tier: 2,
      })
    }
    this.index.addDocuments(docs)
    this.bufferBySession.delete(req.session_id)
    this.flushCount += 1
    return { status: 'extracted' }
  }

  async search(req   
                    
                     
                   
                       
                 
                         
                  
   )                          {
    const ownerType = req.agent_id ? 'agent' : 'user'
    const hits = this.index.search(req.query, req.method ?? 'hybrid', {
      topK: req.top_k ?? 5,
      ownerType,
    })

    const episodes                  = hits.map((h) => ({
      id: h.doc.id,
      subject: h.doc.title,
      summary: h.doc.text,
      episode: h.doc.text,
      score: h.score,
      project_id: h.doc.project_id,
      app_id: h.doc.app_id,
      timestamp: h.doc.date,
    }))

    return {
      episodes,
      profiles: [],
      agent_cases: [],
      agent_skills: [],
      unprocessed_messages: [],
    }
  }
}
