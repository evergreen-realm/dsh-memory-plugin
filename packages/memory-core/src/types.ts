/** Shared contracts across EverOS (MAG), GBrain (RAG/KAG-lite), OpenCode, and DSH. */

export type SearchMethod = 'keyword' | 'vector' | 'hybrid' | 'agentic'
export type ApiVersion = 'auto' | 'v1' | 'v2'
export type Role = 'user' | 'assistant' | 'tool'
export type AppId = 'opencode' | 'dsh' | `import:${string}`

export interface MessageItem {
  sender_id: string
  sender_name?: string
  role: Role
  timestamp: number
  content: string
  tool_calls?: Array<{
    id: string
    type?: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface AddRequest {
  session_id: string
  app_id?: string
  project_id?: string
  messages: MessageItem[]
  defer_extraction?: boolean
}

export interface AddResponse {
  message_count: number
  status: 'accumulated' | 'extracted'
}

export interface FlushRequest {
  session_id: string
  app_id?: string
  project_id?: string
}

export interface FlushResponse {
  status: 'extracted' | 'no_extraction'
}

export interface SearchAtomicFact {
  id: string
  content: string
  score: number
}

export interface SearchEpisode {
  id: string
  subject: string
  summary: string
  episode: string
  score: number
  project_id?: string
  app_id?: string
  timestamp?: string
  atomic_facts?: SearchAtomicFact[]
}

export interface SearchProfile {
  id: string
  profile_data: Record<string, unknown>
  score?: number | null
}

export interface SearchAgentCase {
  id: string
  task_intent: string
  approach: string
  quality_score: number
  key_insight?: string | null
  score: number
}

export interface SearchAgentSkill {
  id: string
  name: string
  description: string
  content: string
  confidence: number
  maturity_score: number
  score: number
}

export interface SearchResponse {
  episodes: SearchEpisode[]
  profiles: SearchProfile[]
  agent_cases: SearchAgentCase[]
  agent_skills: SearchAgentSkill[]
  unprocessed_messages: unknown[]
}

export type EntityType =
  | 'person'
  | 'project'
  | 'decision'
  | 'meeting'
  | 'session'
  | 'skill'
  | 'repository'
  | 'preference'
  | 'concept'

export type RelationType =
  | 'decided_on'
  | 'belongs_to'
  | 'authored_by'
  | 'depends_on'
  | 'supersedes'
  | 'resolved_by'
  | 'uses_skill'
  | 'amends'

export interface GraphNode {
  id: string
  type: EntityType
  title: string
  summary: string
  date?: string // YYYY-MM-DD
  project_id?: string
  source_tier?: 1 | 2 | 3
  tags?: string[]
  superseded_by?: string
}

export interface GraphEdge {
  from: string
  to: string
  relation: RelationType
  since?: string // YYYY-MM-DD
  rationale?: string
}

export interface LogicalFormQuery {
  matchedByRule: boolean
  intent: 'decision_lookup' | 'dependency_walk' | 'ownership' | 'resolution' | 'skill_lookup' | 'general'
  seedEntities: string[]
  targetTypes: EntityType[]
  preferredRelations: RelationType[]
  sinceDate?: string
  untilDate?: string
  includeSuperseded: boolean
  maxHops: number
}

export interface RankedMemoryItem {
  id: string
  source: 'everos-user' | 'everos-agent' | 'gbrain-hybrid' | 'kag-lite' | 'local-hybrid'
  title: string
  snippet: string
  score: number
  hopPath?: string[]
  date?: string
  project_id?: string
}

export interface RecallResult {
  block: string
  items: RankedMemoryItem[]
  cacheHit: boolean
  latencyMs: number
  charCount: number
  tokensInjected: number
  mode: SearchMethod | 'kag-lite'
}

export interface PromotionCandidate {
  id: string
  title: string
  pageType: EntityType
  content: string
  provenance: {
    sessionId: string
    appId: string
    projectId: string
    episodeId?: string
    createdAt: string
  }
  edges?: GraphEdge[]
  status: 'pending' | 'approved' | 'rejected'
}

export interface MemoryStatsSnapshot {
  recallCalls: number
  cacheHits: number
  captureMessages: number
  deferredAdds: number
  flushCalls: number
  compactionsTakenOver: number
  compactionCallsSaved: number
  promotionsQueued: number
  promotionsApproved: number
  redactedSecretsCount: number
  dailyWritesBlockedByBudget: number
  estimatedTokensInjected: number
  estimatedTokensBaseline: number
  estimatedTokensSaved: number
  avgRecallLatencyMs: number
}

export interface MemoryCoreConfig {
  everosUrl: string
  gbrainUrl: string
  appId: AppId
  userId: string
  agentId: string
  recallMethod: SearchMethod
  enableKagLite: boolean
  recallTopK: number
  recallMaxChars: number
  cacheTtlMs: number
  recallTimeoutMs: number
  captureTimeoutMs: number
  flushIdleMs: number
  flushTokenThreshold: number
  flushMessageThreshold: number
  flushMaxDelayMs: number
  dailyWriteCap: number
  statsPath?: string
  appContextPath?: string
  enableAppSessionAwareness?: boolean
  gbrainToken?: string
  crossAppIds?: string[]
}
