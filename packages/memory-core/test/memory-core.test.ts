import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DailyBudgetGuard,
  HttpEverosClient,
  HttpGBrainMcpClient,
  HybridRetrievalIndex,
  InMemoryEverosEngine,
  InMemoryGBrainStore,
  MemoryOrchestrator,
  TtlCache,
  buildDefaultAppSessionContext,
  deriveProjectId,
  formatAppSessionAwarenessBlock,
  isMemoryOptedOut,
  kagLiteSearch,
  packRecallBlock,
  parseLogicalForm,
  redactSecrets,
  updateLiveSessionState,
} from '../src/index.ts'

test('redactSecrets masks tokens, API keys, passwords, and private keys', () => {
  const raw = [
    'Use ghp_1234567890abcdefghij1234567890abcdef and sk-abcdef1234567890abcdef1234',
    'hf_abcdefghijklmnopqrstuvwxyz12345678',
    'password=super_secret_pw_99',
    '-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----',
  ].join('\n')

  const res = redactSecrets(raw)
  assert.equal(res.redactedCount, 5)
  assert.doesNotMatch(res.text, /ghp_12345/)
  assert.doesNotMatch(res.text, /sk-abcdef/)
  assert.doesNotMatch(res.text, /hf_abcdef/)
  assert.doesNotMatch(res.text, /super_secret_pw_99/)
  assert.doesNotMatch(res.text, /abc123/)
  assert.match(res.text, /\[REDACTED:/)
})

test('isMemoryOptedOut detects inline [[memory:off]] and .memory-off files up directory tree', () => {
  assert.equal(isMemoryOptedOut({ text: 'please remember [[memory:off]] secret' }), true)
  assert.equal(isMemoryOptedOut({ text: 'normal engineering query' }), false)

  const dir = mkdtempSync(join(tmpdir(), 'memoff-'))
  try {
    const sub = join(dir, 'nested', 'leaf')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(dir, '.memory-off'), '')
    assert.equal(isMemoryOptedOut({ cwd: sub }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packRecallBlock enforces topK=5 and <= 4,000 char ceiling inside untrusted XML fences', () => {
  const items = Array.from({ length: 8 }, (_, idx) => ({
    id: `item-${idx}`,
    source: 'gbrain-hybrid' as const,
    title: `Decision ${idx}`,
    snippet: 'X'.repeat(1100),
    score: 0.9 - idx * 0.05,
  }))

  const packed = packRecallBlock(items, { topK: 5, maxChars: 4000, fencedTag: 'evergreen_memory' })
  assert.ok(packed.charCount <= 4000, `Expected <= 4000 chars, got ${packed.charCount}`)
  assert.ok(packed.packed.length <= 5 && packed.packed.length >= 1)
  assert.ok(packed.block.startsWith('<evergreen_memory untrusted="true"'))
  assert.ok(packed.block.trimEnd().endsWith('</evergreen_memory>'))
})

test('TtlCache expires entries and DailyBudgetGuard enforces Q-14 cap', () => {
  const cache = new TtlCache<string>(1000)
  const key = TtlCache.makeKey('Hybrid RRF', 'proj')
  cache.set(key, 'cached-value', 500, 10000)
  assert.equal(cache.get(key, 10200), 'cached-value')
  assert.equal(cache.get(key, 10600), undefined)

  const guard = new DailyBudgetGuard(3)
  assert.equal(guard.canWrite(2), true)
  guard.consumeWrite(2)
  assert.equal(guard.remaining(), 1)
  assert.equal(guard.canWrite(2), false)
})

test('HybridRetrievalIndex RRF combines BM25 keyword and semantic vector results', () => {
  const index = new HybridRetrievalIndex([
    {
      id: 'd1',
      owner_type: 'agent',
      title: 'EverOS Queue Strategy',
      text: 'Use defer_extraction=true with adaptive 15s idle flush on POST /api/v2/memory/add',
      date: '2026-11-11',
    },
    {
      id: 'd2',
      owner_type: 'agent',
      title: 'Token Ceiling Policy',
      text: 'Cap recall blocks at 4000 characters and topK=5 with 15-minute TTL cache',
      date: '2026-11-10',
    },
  ])

  const kw = index.searchKeyword('defer_extraction POST /api/v2/memory/add', { topK: 2 })
  assert.equal(kw[0]?.doc.id, 'd1')

  const vec = index.searchVector('delay extraction batching idle timer', { topK: 2 })
  assert.equal(vec[0]?.doc.id, 'd1')

  const hybrid = index.searchHybridRRF('token limit 4000 chars cache', { topK: 2 })
  assert.equal(hybrid[0]?.doc.id, 'd2')
})

test('parseLogicalForm and kagLiteSearch resolve multi-hop, ownership, temporal & superseding edges', async () => {
  const store = new InMemoryGBrainStore(
    [
      {
        id: 'projects/evergreen',
        type: 'project',
        title: 'Project Evergreen',
        summary: 'Cross-harness coding memory control center',
        date: '2026-10-01',
      },
      {
        id: 'decisions/old-rag',
        type: 'decision',
        title: 'Phase 0 Keyword Only',
        summary: 'Original keyword-only grep prototype',
        date: '2026-09-15',
        superseded_by: 'decisions/kag-lite',
      },
      {
        id: 'decisions/kag-lite',
        type: 'decision',
        title: 'Option B KAG-lite on GBrain',
        summary: 'Adopted typed edges on GBrain with Logical Form query parser (Q-2)',
        date: '2026-11-12',
      },
      {
        id: 'people/mishael',
        type: 'person',
        title: 'Mishael',
        summary: 'Primary architect maintaining opencode-control-center',
        date: '2026-10-01',
      },
    ],
    [
      { from: 'decisions/kag-lite', to: 'projects/evergreen', relation: 'decided_on', since: '2026-11-12' },
      { from: 'decisions/kag-lite', to: 'decisions/old-rag', relation: 'supersedes', since: '2026-11-12' },
      { from: 'decisions/kag-lite', to: 'people/mishael', relation: 'authored_by', since: '2026-11-12' },
    ],
  )

  const lf = parseLogicalForm('What decision superseded keyword prototype on Project Evergreen since 2026-11-01?')
  assert.equal(lf.matchedByRule, true)
  assert.equal(lf.sinceDate, '2026-11-01')

  const res = await kagLiteSearch('Who authored the Option B KAG-lite decision on Project Evergreen?', store, { topK: 5 })
  assert.ok(res.items.some((h) => h.id === 'decisions/kag-lite'))
  assert.ok(res.items.some((h) => h.id === 'people/mishael'))
  // Superseded nodes should be excluded unless explicitly requested
  assert.equal(res.items.some((h) => h.id === 'decisions/old-rag'), false)
})

test('MemoryOrchestrator end-to-end: recall caching, secret redaction, compaction takeover, Q-3 approval-gated promotion', async () => {
  const everos = new InMemoryEverosEngine()
  const gbrain = new InMemoryGBrainStore([
    {
      id: 'decisions/dsh-mode',
      type: 'decision',
      title: 'DSH Normal Mode Registration',
      summary: 'Register @evergreen-realm/dsh-memory-plugin via dsh.cmd plugin --profile desktop add',
      date: '2026-11-12',
      project_id: 'repo-alpha',
    },
  ])

  const orch = new MemoryOrchestrator({
    config: {
      appId: 'opencode',
      flushMessageThreshold: 2,
      dailyWriteCap: 10,
    },
    everos,
    gbrain,
  })

  try {
    // 1. Capture turns with secret redaction & automatic threshold flush
    const cap = await orch.capture({
      sessionId: 'sess-1',
      projectId: 'repo-alpha',
      messages: [
        { role: 'user', content: 'Register DSH desktop plugin with token ghp_1234567890abcdefghij1234567890abcdef' },
        { role: 'assistant', content: 'Registered normal-mode Cordis bundle into ~/.dsh/profiles/desktop' },
      ],
    })
    assert.equal(cap.captured, 2)
    assert.equal(cap.flushed, true)

    // 2. First recall misses cache, hits stores, obeys 4000-char ceiling
    const first = await orch.recall({ query: 'DSH desktop plugin registration', projectId: 'repo-alpha' })
    assert.equal(first.cacheHit, false)
    assert.ok(first.items.length >= 1)
    assert.ok(first.charCount <= 4000)

    // 3. Second identical recall hits 15-min TTL cache with 0 injected repeat delta
    const second = await orch.recall({ query: 'DSH desktop plugin registration', projectId: 'repo-alpha' })
    assert.equal(second.cacheHit, true)

    // 4. Opt-out prevents recall & capture
    const opted = await orch.recall({ query: 'DSH desktop plugin [[memory:off]]', projectId: 'repo-alpha' })
    assert.equal(opted.block, '')

    // 5. Compaction takeover summarizes locally and saves LLM call
    const compactText = orch.takeOverCompaction({
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'Deploy gbrain schema pack with key sk-abcdef1234567890abcdef1234' },
        { role: 'assistant', content: 'Decision: load gbrain-memory-v1 on startup' },
      ],
      recalled: first.items,
    })
    assert.match(compactText, /# Local Checkpoint Summary/)
    assert.doesNotMatch(compactText, /sk-abcdef/)

    // 6. Q-3 approval-gated promotion: queued pending -> not in GBrain until approved
    const cand = orch.proposePromotion({
      id: 'dsh-approval-rule',
      title: 'DSH Normal Mode Rule',
      pageType: 'decision',
      content: 'Always keep Creator Mode disabled',
      provenance: {
        sessionId: 'sess-1',
        appId: 'opencode',
        projectId: 'repo-alpha',
        createdAt: '2026-11-12T03:00:00Z',
      },
    })
    assert.equal(orch.listPendingPromotions().length, 1)
    assert.equal(await gbrain.getPage('decisions/dsh-approval-rule'), undefined)

    const approved = await orch.approvePromotion(cand.id, true)
    assert.equal(approved.status, 'approved')
    assert.ok(await gbrain.getPage('decisions/dsh-approval-rule'))

    const stats = orch.getStats()
    assert.equal(stats.compactionCallsSaved, 1)
    assert.ok(stats.redactedSecretsCount >= 1)
    assert.equal(stats.promotionsApproved, 1)
    assert.equal(deriveProjectId('C:/repos/my-app'), 'my-app')
  } finally {
    orch.dispose()
  }
})

test('HttpEverosClient unwraps EverOS 1.6.0 data envelopes and MemoryOrchestrator includes bounded app+session awareness', async () => {
  const seenUrls: string[] = []
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input)
    seenUrls.push(url)
    if (url.endsWith('/api/v2/memory/add')) {
      return new Response(
        JSON.stringify({ request_id: 'r1', data: { message_count: 1, status: 'accumulated' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        request_id: 'r2',
        data: {
          episodes: [
            {
              id: 'ep-1',
              subject: 'Phase 5 Status',
              summary: 'EverOS 8000 active with Kaggle Dual-T4 dispatcher',
              episode: 'EverOS 8000 active',
              score: 0.91,
            },
          ],
          profiles: [],
          agent_cases: [],
          agent_skills: [],
          unprocessed_messages: [],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const client = new HttpEverosClient('http://127.0.0.1:8000', 'auto', fakeFetch)
  const addRes = await client.add({
    session_id: 'ses-test',
    app_id: 'dsh',
    messages: [{ sender_id: 'dev', role: 'tool', timestamp: Date.now(), content: 'tool ok', tool_call_id: 'tc_0' }],
  })
  assert.equal(addRes.message_count, 1)
  assert.equal(addRes.status, 'accumulated')

  const gbrain = new InMemoryGBrainStore([])
  const orch = new MemoryOrchestrator({
    config: { appId: 'dsh', recallMaxChars: 4000, enableAppSessionAwareness: true },
    everos: client,
    gbrain,
  })
  try {
    const recalled = await orch.recall({
      query: 'Where are we at in the application?',
      cwd: 'C:/Users/lenovo/workspaces/research-123',
      sessionId: 'dsh-live-1',
      appContext: buildDefaultAppSessionContext('C:/Users/lenovo/workspaces/research-123'),
    })
    assert.ok(seenUrls.some((u) => u.endsWith('/api/v2/memory/search')))
    assert.ok(recalled.charCount <= 4000)
    assert.match(recalled.block, /<app_session_awareness/)
    assert.match(recalled.block, /research-123/)
    assert.match(recalled.block, /EverOS 8000 active/)

    const compactAwareness = formatAppSessionAwarenessBlock(
      buildDefaultAppSessionContext('C:/Users/lenovo/workspaces/system-project'),
      { maxChars: 600 },
    )
    assert.ok(compactAwareness.length <= 600)

    // Track A: GBrain async write_pending must be treated as accepted write, not error
    const pendingClient = new HttpGBrainMcpClient('http://127.0.0.1:3131', 'test-tok', (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: 'write_pending', message: 'The write is accepted and awaiting completion; it is not committed.' }) }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch)
    const pendingRes = await pendingClient.putPage({
      id: 'sessions/test-pending',
      type: 'session',
      title: 'Test Pending',
      summary: 'Summary',
      source_tier: 2,
    })
    assert.equal(pendingRes.ok, true)
    assert.equal(pendingRes.pending, true)

    // Track A: loadAppSessionContext / updateLiveSessionState strips numeric string-spread corruption keys
    const ctxTmp = mkdtempSync(join(tmpdir(), 'ws-ctx-test-'))
    try {
      const corruptedPath = join(ctxTmp, 'app-session-context.json')
      writeFileSync(
        corruptedPath,
        JSON.stringify({
          liveSession: { '0': 'C', '1': ':', '2': '\\', milestone: 'ok', updatedAt: '2026-01-01T00:00:00Z' },
        }),
      )
      const cleaned = updateLiveSessionState({ activeSessionId: 'ses-clean' }, { path: corruptedPath })
      assert.equal((cleaned.liveSession as unknown as Record<string, unknown>)['0'], undefined)
      assert.equal(cleaned.liveSession.activeSessionId, 'ses-clean')
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true })
    }
  } finally {
    orch.dispose()
  }
})
