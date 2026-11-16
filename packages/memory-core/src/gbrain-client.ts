/** GBrain HTTP MCP (:3131) + Graph Store client for RAG + KAG-lite (§4-B). */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { GraphEdge, GraphNode, RelationType } from './types.ts'

export interface GBrainSearchHit {
  id: string
  slug: string
  title: string
  snippet: string
  score: number
  type?: string
  date?: string
  tags?: string[]
  source_tier?: 1 | 2 | 3
}

export interface GBrainTransport {
  health(timeoutMs?: number): Promise<{ status: string; version?: string }>
  query(query: string, opts?: { topK?: number; mode?: 'keyword' | 'vector' | 'hybrid' }): Promise<GBrainSearchHit[]>
  putPage(node: GraphNode, edges?: readonly GraphEdge[]): Promise<{ slug: string; ok: boolean; pending?: boolean }>
  getPage(slugOrId: string): Promise<GraphNode | undefined>
  neighbors(nodeId: string, relations?: readonly RelationType[]): Promise<Array<{ edge: GraphEdge; node: GraphNode }>>
  allNodes(): Promise<GraphNode[]>
}

function resolveDefaultGbrainToken(explicitToken?: string): string | undefined {
  if (explicitToken) return explicitToken
  const envTok = process.env.GBRAIN_TOKEN ?? process.env.GBRAIN_ACCESS_TOKEN
  if (envTok) return envTok
  const credPaths = [
    process.env.GBRAIN_CREDENTIALS_FILE,
    join(homedir(), '.evergreen-memory', 'gbrain-creds.json'),
  ].filter((p): p is string => Boolean(p))
  for (const cp of credPaths) {
    if (!existsSync(cp)) continue
    try {
      const parsed = JSON.parse(readFileSync(cp, 'utf8')) as { access_token?: string }
      if (parsed.access_token) return parsed.access_token
    } catch {
      // Ignore unreadable credentials file and continue fail-open
    }
  }
  return undefined
}

function parseMcpRpcBody<T>(rawText: string, contentType: string): { result?: { content?: Array<{ text?: string }>; structuredContent?: T }; error?: { message: string } } {
  const trimmed = rawText.trim()
  if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLines = trimmed
      .split(/\r?\n/u)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(dataLines[i]!) as { result?: { content?: Array<{ text?: string }>; structuredContent?: T }; error?: { message: string } }
      } catch {
        // Keep scanning backward for valid JSON-RPC frame
      }
    }
  }
  return JSON.parse(trimmed) as { result?: { content?: Array<{ text?: string }>; structuredContent?: T }; error?: { message: string } }
}

export class HttpGBrainMcpClient implements GBrainTransport {
  private reqCounter = 0
  private readonly baseUrl: string
  private readonly authToken?: string
  private readonly fetchFn: typeof fetch

  constructor(
    baseUrl = 'http://127.0.0.1:3131',
    authToken?: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl
    this.authToken = resolveDefaultGbrainToken(authToken)
    this.fetchFn = fetchFn
  }

  async health(timeoutMs = 3000): Promise<{ status: string; version?: string }> {
    const clean = this.baseUrl.replace(/\/+$/u, '')
    const res = await this.fetchFn(`${clean}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`GBrain /health HTTP ${res.status}`)
    return (await res.json()) as { status: string; version?: string }
  }

  private async mcpCall<T>(name: string, args: Record<string, unknown>, timeoutMs = 6000): Promise<T> {
    const clean = this.baseUrl.replace(/\/+$/u, '')
    this.reqCounter += 1
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`

    const res = await this.fetchFn(`${clean}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.reqCounter,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`GBrain MCP tools/call ${name} HTTP ${res.status}`)
    const ctype = res.headers.get('content-type') ?? ''
    const payload = parseMcpRpcBody<T>(await res.text(), ctype)
    if (payload.error) {
      const msg = payload.error.message ?? String(payload.error)
      if (/write_pending|accepted and awaiting completion/iu.test(msg)) {
        return { ok: true, pending: true, status: 'write_pending', message: msg } as unknown as T
      }
      throw new Error(msg)
    }
    if (payload.result?.structuredContent !== undefined) return payload.result.structuredContent
    const text = payload.result?.content?.[0]?.text ?? '{}'
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      if (/write_pending|accepted and awaiting completion/iu.test(text)) {
        return { ok: true, pending: true, status: 'write_pending', message: text } as unknown as T
      }
      return { raw: text } as unknown as T
    }
    if (parsed && typeof parsed.error === 'string') {
      const msg = typeof parsed.message === 'string' ? parsed.message : parsed.error
      if (/write_pending|accepted and awaiting completion/iu.test(`${parsed.error} ${msg}`)) {
        return { ...parsed, ok: true, pending: true, status: 'write_pending' } as unknown as T
      }
      throw new Error(msg)
    }
    return parsed as unknown as T
  }

  private async callWithFallback<T>(
    primary: { name: string; args: Record<string, unknown> },
    fallback: { name: string; args: Record<string, unknown> },
    timeoutMs = 8000,
  ): Promise<T> {
    try {
      return await this.mcpCall<T>(primary.name, primary.args, timeoutMs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/unknown/i.test(msg)) {
        return this.mcpCall<T>(fallback.name, fallback.args, timeoutMs)
      }
      throw err
    }
  }

  async query(query: string, opts: { topK?: number; mode?: 'keyword' | 'vector' | 'hybrid' } = {}): Promise<GBrainSearchHit[]> {
    const limit = opts.topK ?? 5
    const res = await this.callWithFallback<{
      facts?: Array<Record<string, unknown>>
      results?: Array<Record<string, unknown>>
    }>(
      { name: 'recall', args: { query, limit, max_chars: 2800 } },
      { name: 'query', args: { query, limit, mode: opts.mode ?? 'hybrid' } },
    )
    const factRows = (res.facts ?? []).map((f, idx) => {
      const rawFact = String(f.fact ?? '')
      const cleaned = rawFact
        .replace(/^\[quoted conversation excerpt[^\]]*\]\s*/iu, '')
        .replace(/^```text\s*|\s*```$/gu, '')
        .trim()
      const entity = String(f.entity_slug ?? f.entity ?? `gbrain-fact-${f.id ?? idx}`)
      return {
        id: String(f.id ?? entity),
        slug: entity,
        title: entity,
        snippet: cleaned.slice(0, 600),
        score: typeof f.score === 'number' ? f.score : Math.max(0.2, 0.95 - idx * 0.08),
        type: typeof f.kind === 'string' ? f.kind : undefined,
        date: typeof f.valid_from === 'string' ? f.valid_from.slice(0, 10) : undefined,
      }
    })
    const pageRows = (res.results ?? []).map((r, idx) => ({
      id: String(r.id ?? r.slug ?? `gb-${idx}`),
      slug: String(r.slug ?? r.id ?? ''),
      title: String(r.title ?? r.slug ?? 'GBrain Page'),
      snippet: String(r.snippet ?? r.excerpt ?? r.content ?? '').slice(0, 600),
      score: typeof r.score === 'number' ? r.score : Math.max(0.1, 1 - idx * 0.1),
      type: typeof r.type === 'string' ? r.type : undefined,
    }))
    return [...factRows, ...pageRows].slice(0, limit)
  }

  async putPage(node: GraphNode, edges: readonly GraphEdge[] = []): Promise<{ slug: string; ok: boolean; pending?: boolean }> {
    const frontmatterLinks = edges.map((e) => ({ relation: e.relation, to: e.to, since: e.since, rationale: e.rationale }))
    const factText = `${node.title}: ${node.summary}${frontmatterLinks.length > 0 ? ` | links=${JSON.stringify(frontmatterLinks)}` : ''}`
    const kind = node.type === 'preference' ? 'preference' : 'fact'
    try {
      const res = await this.callWithFallback<{ pending?: boolean; status?: string }>(
        {
          name: 'remember',
          args: {
            entity: node.id,
            fact: factText.slice(0, 1800),
            kind,
            provenance: `Evergreen Memory (${node.project_id ?? 'global'} | ${node.date ?? new Date().toISOString().slice(0, 10)})`,
          },
        },
        {
          name: 'put_page',
          args: {
            slug: node.id,
            title: node.title,
            type: node.type,
            content: `${node.summary}\n\n${frontmatterLinks.length > 0 ? JSON.stringify({ links: frontmatterLinks }) : ''}`.trim(),
          },
        },
      )
      return { slug: node.id, ok: true, ...(res?.pending ? { pending: true } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/write_pending|accepted and awaiting completion/iu.test(msg)) {
        return { slug: node.id, ok: true, pending: true }
      }
      throw err
    }
  }

  async getPage(slugOrId: string): Promise<GraphNode | undefined> {
    try {
      const p = await this.callWithFallback<{
        found?: boolean
        entity?: { slug?: string; name?: string; kind?: string; summary?: string }
        slug?: string
        title?: string
        type?: string
        content?: string
      }>(
        { name: 'entity', args: { name: slugOrId } },
        { name: 'get_page', args: { slug: slugOrId } },
      )
      if (p.entity && p.found !== false) {
        return {
          id: p.entity.slug ?? slugOrId,
          type: (p.entity.kind as GraphNode['type']) ?? 'concept',
          title: p.entity.name ?? slugOrId,
          summary: p.entity.summary ?? '',
        }
      }
      if (!p || !p.title) return undefined
      return {
        id: p.slug ?? slugOrId,
        type: (p.type as GraphNode['type']) ?? 'concept',
        title: p.title,
        summary: p.content ?? '',
      }
    } catch {
      return undefined
    }
  }

  async neighbors(nodeId: string, _relations?: readonly RelationType[]): Promise<Array<{ edge: GraphEdge; node: GraphNode }>> {
    try {
      const res = await this.mcpCall<{ links?: Array<{ target?: string; relation?: string; since?: string }> }>('get_page', {
        slug: nodeId,
        include_links: true,
      })
      const out: Array<{ edge: GraphEdge; node: GraphNode }> = []
      for (const l of res.links ?? []) {
        if (!l.target) continue
        const targetNode = await this.getPage(l.target)
        if (targetNode) {
          out.push({
            edge: { from: nodeId, to: l.target, relation: (l.relation as RelationType) ?? 'depends_on', since: l.since },
            node: targetNode,
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async allNodes(): Promise<GraphNode[]> {
    return []
  }
}

/** In-memory GBrain-compatible property graph + hybrid page index (used for tests, offline mode, & A/B/KAG benchmarks). */
export class InMemoryGBrainStore implements GBrainTransport {
  private readonly nodes = new Map<string, GraphNode>()
  private readonly edges: GraphEdge[] = []

  constructor(initialNodes: readonly GraphNode[] = [], initialEdges: readonly GraphEdge[] = []) {
    for (const n of initialNodes) this.nodes.set(n.id, n)
    for (const e of initialEdges) this.edges.push(e)
  }

  async health(): Promise<{ status: string; version?: string }> {
    return { status: 'ok', version: 'inmemory-kag-lite' }
  }

  async query(query: string, opts: { topK?: number; mode?: 'keyword' | 'vector' | 'hybrid' } = {}): Promise<GBrainSearchHit[]> {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9:_-]+/)
      .filter((t) => t.length > 1)
    const scored: GBrainSearchHit[] = []
    for (const node of this.nodes.values()) {
      const hay = `${node.id} ${node.type} ${node.title} ${node.summary} ${(node.tags ?? []).join(' ')}`.toLowerCase()
      let hits = 0
      for (const tok of tokens) {
        if (hay.includes(tok)) hits += 1
      }
      if (hits > 0) {
        const tierBoost = node.source_tier === 1 ? 1.15 : node.source_tier === 2 ? 1.0 : 0.9
        scored.push({
          id: node.id,
          slug: node.id,
          title: node.title,
          snippet: node.summary,
          score: (hits / Math.max(1, tokens.length)) * tierBoost,
          type: node.type,
          date: node.date,
          tags: node.tags,
          source_tier: node.source_tier,
        })
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.topK ?? 5)
  }

  async putPage(node: GraphNode, edges: readonly GraphEdge[] = []): Promise<{ slug: string; ok: boolean }> {
    this.nodes.set(node.id, { ...node })
    for (const e of edges) {
      const exists = this.edges.some(
        (x) => x.from === e.from && x.to === e.to && x.relation === e.relation && x.since === e.since,
      )
      if (!exists) this.edges.push({ ...e })
    }
    return { slug: node.id, ok: true }
  }

  async getPage(slugOrId: string): Promise<GraphNode | undefined> {
    return this.nodes.get(slugOrId)
  }

  async neighbors(nodeId: string, relations?: readonly RelationType[]): Promise<Array<{ edge: GraphEdge; node: GraphNode }>> {
    const out: Array<{ edge: GraphEdge; node: GraphNode }> = []
    const relSet = relations && relations.length > 0 ? new Set(relations) : null
    for (const edge of this.edges) {
      if (relSet && !relSet.has(edge.relation)) continue
      if (edge.from === nodeId) {
        const target = this.nodes.get(edge.to)
        if (target) out.push({ edge, node: target })
      } else if (edge.to === nodeId) {
        const src = this.nodes.get(edge.from)
        if (src) out.push({ edge: { ...edge, from: edge.to, to: edge.from }, node: src })
      }
    }
    return out
  }

  async allNodes(): Promise<GraphNode[]> {
    return [...this.nodes.values()]
  }
}
