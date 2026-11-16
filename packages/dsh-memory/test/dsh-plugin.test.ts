import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InMemoryEverosEngine,
  InMemoryGBrainStore,
  MemoryOrchestrator,
  YESTERDAY_OPENCODE_SESSION_ID,
} from '../../memory-core/dist/index.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const DIST_ENTRY = join(TEST_DIR, '..', 'dist', 'index.js')

test('DSH Cordis plugin (compiled dist/index.js) boots startupPreflight, handles DSH 0.2.2-rc.1 pre-step/turn-stopping, registers 9 bridge tools & saves >50% tokens', async () => {
  const plugin = (await import(`file:///${DIST_ENTRY.replace(/\\/g, '/')}`)) as typeof import('../src/index.ts')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'))

  const corpusPath = join(tmp, 'ingested-corpus.jsonl')
  writeFileSync(
    corpusPath,
    JSON.stringify({
      id: 'ses_f31d8cd0:turn:1',
      session_id: YESTERDAY_OPENCODE_SESSION_ID,
      workspace: 'research-123',
      title: 'Yesterday session stopped by network issues',
      speaker_role: 'assistant',
      category: 'dsh_memory_plugin',
      text: 'Install @evergreen-realm/dsh-memory-plugin in desktop profile without Creator Mode via link.',
    }) + '\n',
    'utf8',
  )
  const ysDir = join(tmp, 'yesterday_session')
  mkdirSync(ysDir, { recursive: true })
  writeFileSync(
    join(ysDir, 'yesterday_session_messages.jsonl'),
    JSON.stringify({
      session_id: YESTERDAY_OPENCODE_SESSION_ID,
      seq: 0,
      role: 'user',
      text: 'Verify DiffPure and GFPGAN weights manifest',
    }) + '\n',
    'utf8',
  )
  writeFileSync(
    join(ysDir, 'yesterday_session_files_manifest.json'),
    JSON.stringify({ session_id: YESTERDAY_OPENCODE_SESSION_ID, total_unique_paths_referenced: 2262 }),
    'utf8',
  )

  const everos = new InMemoryEverosEngine()
  const gbrain = new InMemoryGBrainStore([
    {
      id: 'decisions/dsh-desktop',
      type: 'decision',
      title: 'DSH Normal Mode Cordis Registration',
      summary: 'Install @evergreen-realm/dsh-memory-plugin via dsh.cmd plugin --profile desktop add without Creator Mode',
      date: '2026-11-12',
    },
  ])

  const appCtxPath = join(tmp, 'app-session-context.json')
  const preflightPath = join(tmp, 'startup-preflight.json')
  const pluginLogPath = join(tmp, 'dsh-plugin.log')

  const orch = new MemoryOrchestrator({
    config: { appId: 'dsh', flushMessageThreshold: 4, appContextPath: appCtxPath },
    everos,
    gbrain,
  })

  const handlers = new Map<string, (...args: any[]) => any>()
  const registeredTools = new Map<string, any>()
  const registeredContexts = new Map<string, any>()
  const disposers: Array<() => void> = []

  const fakeCtx = {
    on(event: string, listener: (...args: any[]) => any) {
      handlers.set(event, listener)
    },
    effect(cb: () => () => void) {
      disposers.push(cb())
    },
    tools: {
      register(def: any) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
    },
    systemPrompt: {
      context(entry: any) {
        registeredContexts.set(entry.name, entry)
        return () => registeredContexts.delete(entry.name)
      },
    },
  }

  await plugin.apply(fakeCtx, {
    orchestrator: orch,
    fencedTag: 'context',
    evergreenDir: tmp,
    appContextPath: appCtxPath,
    corpusPath,
    yesterdayDir: ysDir,
    checkpointPath: join(tmp, 'ingest-checkpoint.json'),
    preflightOutputPath: preflightPath,
    pluginLogPath,
    dshHome: tmp,
    ollamaApiKey: 'test-ollama-key',
    runner: async (cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') return { stdout: JSON.stringify({ state: 'Available' }), stderr: '', exitCode: 0 }
      if (cmd === 'python') return { stdout: JSON.stringify({ total: 1, files: ['vault/demo.txt'] }), stderr: '', exitCode: 0 }
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    },
    fetchFn: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
  })

  try {
    // 1. Startup Preflight wrote ready report + log BEFORE Step 0
    assert.ok(existsSync(preflightPath))
    assert.ok(existsSync(pluginLogPath))
    const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'))
    assert.equal(preflight.status, 'ready')
    assert.ok(orch.getLocalIndexSize() >= 1)

    // 2. All 14 Cordis bridge tools (9 core + 4 GBrain + web_deep_research) registered with strict schema
    const expectedTools = [
      'opencode_session_search',
      'opencode_session_read',
      'codespace_status',
      'codespace_exec',
      'codespace_sync',
      'hf_vault_list',
      'hf_vault_download',
      'hf_vault_upload',
      'hf_vault_status',
      'gbrain_recall',
      'gbrain_remember',
      'gbrain_entity',
      'gbrain_context_pack',
      'web_deep_research',
    ]
    for (const tName of expectedTools) {
      const def = registeredTools.get(tName)
      assert.ok(def, `Missing registered Cordis tool: ${tName}`)
      assert.equal(typeof def.output?.render, 'function')
      assert.equal(def.output?.schema?.type, 'object')
      assert.equal(def.output?.schema?.additionalProperties, false)
    }

    // Execute opencode_session_search + hf_vault_list + codespace_status tools
    const searchToolOut = await registeredTools.get('opencode_session_search').execute({ query: 'DiffPure' })
    assert.equal(searchToolOut.ok, true)
    assert.match(searchToolOut.dataJson, /yesterday_session/)
    const csToolOut = await registeredTools.get('codespace_status').execute({})
    assert.equal(csToolOut.ok, true)
    const hfToolOut = await registeredTools.get('hf_vault_list').execute({})
    assert.equal(hfToolOut.ok, true)

    // 3. Real DSH 0.2.2-rc.1 Session + Agent mock with trailing synthetic runtime-context & time-context
    const sessionEvents: any[] = [
      {
        seq: 0,
        type: 'user/message',
        time: Date.now(),
        data: {
          id: 'u-1',
          role: 'user',
          content: [{ type: 'text', text: 'How should DSH desktop register the memory plugin without Creator Mode?' }],
          source: { kind: 'user' },
        },
      },
      {
        seq: 1,
        type: 'user/message',
        time: Date.now(),
        data: {
          id: 'syn-rt',
          role: 'user',
          content: [{ type: 'text', text: 'Current runtime context snapshot: ignore this synthetic prompt' }],
          source: { kind: 'runtime-context', form: 'snapshot' },
        },
      },
      {
        seq: 2,
        type: 'user/message',
        time: Date.now(),
        data: {
          id: 'syn-time',
          role: 'user',
          content: [{ type: 'text', text: 'Current time is 2026-11-14T18:00:00Z' }],
          source: { kind: 'dsh-time-context', form: 'snapshot' },
        },
      },
    ]

    const agent = {
      id: 'dsh-coder',
      session: {
        id: 'dsh-ses-1',
        seq: 3,
        header: { cwd: 'C:/Users/lenovo/workspaces/research-123' },
        snapshotEvents(fromSeq = 0) {
          return sessionEvents.filter((e) => e.seq >= fromSeq)
        },
      },
    }

    const stepInputMsgs = sessionEvents.map((e) => e.data)
    const preStep = handlers.get('agent/pre-step')!
    const out1 = await preStep(
      { agent, messages: stepInputMsgs, turn: 1, step: 0 },
      async () => ({ kind: 'enter', messages: [...stepInputMsgs] }),
    )
    assert.equal(out1.messages.length, 4)
    const recalledMsg = out1.messages[3]
    assert.equal(typeof recalledMsg.id, 'string')
    assert.equal(recalledMsg.role, 'user')
    assert.deepEqual(recalledMsg.source, { kind: 'runtime-context', form: 'recall' })
    assert.ok(Array.isArray(recalledMsg.content))
    assert.equal(recalledMsg.content[0].type, 'text')
    const recalledText: string = recalledMsg.content[0].text
    assert.match(recalledText, /<app_session_awareness/)
    assert.match(recalledText, /research-123/)
    assert.match(recalledText, /DSH Normal Mode Cordis Registration/)
    assert.ok(recalledText.length <= 4000)

    // SystemPrompt dynamic context stays empty to preserve KV-cache prefix across turns (recall goes in append-only tail)
    const ctxEntry = registeredContexts.get('evergreen-memory-recall')
    assert.ok(ctxEntry)
    assert.equal(ctxEntry.interpolate, false)
    assert.equal(ctxEntry.text({ scope: { session: { id: 'dsh-ses-1' } } }), '')

    // Step 1 within the same turn must not re-inject duplicate recall
    const outStep1 = await preStep(
      { agent, messages: stepInputMsgs, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [...stepInputMsgs] }),
    )
    assert.equal(outStep1.messages.length, 3)

    // Repeat query on Turn 2 hits TtlCache -> high token savings
    const out2 = await preStep(
      { agent, messages: stepInputMsgs, turn: 2, step: 0 },
      async () => ({ kind: 'enter', messages: [...stepInputMsgs] }),
    )
    assert.equal(out2.messages.length, 4)
    const statsAfterRecall = orch.getStats()
    assert.ok(statsAfterRecall.cacheHits >= 1)
    assert.ok(statsAfterRecall.estimatedTokensSaved / statsAfterRecall.estimatedTokensBaseline > 0.5)

    // 4. turn-stopping captures real messages from agent.session (skipping synthetic ones), redacts secrets, updates app-session-context.json
    const fakeGh = 'ghp_' + '1234567890abcdefghij1234567890abcdef'
    sessionEvents.push(
      {
        seq: 3,
        type: 'assistant/message',
        time: Date.now(),
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Link @evergreen-realm/dsh-memory-plugin with ${fakeGh}` }],
          },
        },
      },
    )
    agent.session.seq = 4
    await handlers.get('agent/turn-stopping')!({ agent, turn: 1 })
    const stats = orch.getStats()
    assert.equal(stats.captureMessages, 2)
    assert.equal(stats.redactedSecretsCount, 1)
    assert.ok(existsSync(appCtxPath))

    // Second turn-stopping without new events captures 0 duplicates (lastCapturedSeq tracking)
    await handlers.get('agent/turn-stopping')!({ agent, turn: 1 })
    assert.equal(orch.getStats().captureMessages, 2)

    // 5. session/disposed triggers flush & MCP config helper works
    await handlers.get('session/disposed')!({ id: 'dsh-ses-1' })
    assert.equal(orch.getStats().flushCalls, 1)
    assert.equal(plugin.getDshGbrainMcpConfig('http://127.0.0.1:3131').url, 'http://127.0.0.1:3131/mcp')

    // 6. Verify package.json engines.dsh >= 0.2.0 and cordis.patch.yml
    const pkgJson = JSON.parse(readFileSync(join(TEST_DIR, '..', 'package.json'), 'utf8'))
    assert.equal(pkgJson.engines?.dsh, '>=0.2.0')
    const patchYml = readFileSync(join(TEST_DIR, '..', 'cordis.patch.yml'), 'utf8')
    assert.match(patchYml, /name:\s*"@evergreen-realm\/dsh-memory-plugin"/)

    // 7. Emergency pre-step compaction guard trims oversized live history before blowing budget
    const guarded = await handlers.get('agent/pre-step')!(
      {
        agent: { id: 'dsh-ses-big', cwd: tmp, messages: [] },
        messages: [
          { id: 'sys-0', role: 'system', content: [{ type: 'text', text: 'System prompt.' }] },
          { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'A'.repeat(2_200_000) }], source: { kind: 'user' } },
          { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(400_000) }], source: { kind: 'model' } },
          { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'Where are we at in research-123?' }], source: { kind: 'user' } },
        ],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({
        kind: 'continue',
        messages: [
          { id: 'sys-0', role: 'system', content: [{ type: 'text', text: 'System prompt.' }] },
          { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'A'.repeat(2_200_000) }], source: { kind: 'user' } },
          { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(400_000) }], source: { kind: 'model' } },
          { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'Where are we at in research-123?' }], source: { kind: 'user' } },
        ],
      }),
    ) as { messages: Array<{ role: string; content: Array<{ text: string }> }> }
    const totalGuardedChars = guarded.messages.reduce(
      (acc, m) => acc + m.content.reduce((s, c) => s + (c.text?.length ?? 0), 0),
      0,
    )
    assert.ok(totalGuardedChars < 1_800_000, `expected emergency trim <1.8M chars, got ${totalGuardedChars}`)
    assert.ok(
      guarded.messages.some((m) => m.content.some((c) => c.text?.includes('<evergreen_emergency_compaction'))),
      'expected emergency compaction summary block',
    )
    const logAfterGuard = readFileSync(pluginLogPath, 'utf8')
    assert.match(logAfterGuard, /"event":"pre_step_emergency_compaction"/)

    // 8. Verify GBrain, Clef advisor, Ollama web providers, concurrency semaphore <= 3, and ordered 3-tier fallback
    const {
      AsyncSemaphore,
      consultClefAdvisor,
      ollamaWebSearch,
      registerOllamaWebProviders,
      runKimiClawDeepResearch,
    } = await import('../src/web-providers.ts')

    let peakConcurrent = 0
    let activeNow = 0
    const sem = new AsyncSemaphore(3)
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        sem.run(async () => {
          activeNow += 1
          peakConcurrent = Math.max(peakConcurrent, activeNow)
          await new Promise((r) => setTimeout(r, 15))
          activeNow -= 1
          return i
        }),
      ),
    )
    assert.ok(peakConcurrent <= 3 && peakConcurrent >= 2, `expected bounded peak <=3, got ${peakConcurrent}`)

    const mockWebFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (url.endsWith('/api/web_search')) {
        return new Response(
          JSON.stringify({
            results: [
              { title: 'Doc A', url: 'https://example.com/a', content: 'Detailed spec for Ollama Clef API.' },
              { title: 'Doc B', url: 'https://example.com/b', content: 'Spam SEO aggregator.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/v1/systemone')) {
        return new Response(
          JSON.stringify({
            answers: {
              route_tier: { choice: body.state?.query?.includes('quick') ? 'snippet_sufficient' : 'fetch_top_urls' },
              evidence_sufficient: { noul: body.state?.query?.includes('quick') ? 0.92 : 0.35 },
              conflict_detected: { noul: 0.72 },
              url_useful_0: { noul: 0.91 },
              url_useful_1: { noul: 0.12 },
            },
            usage: { input_tokens: 420, output_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/web_fetch')) {
        return new Response(JSON.stringify({ title: 'Doc A', content: 'Extracted markdown body', links: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/v1/chat/completions')) {
        const content =
          body.model === 'glm-5.3-flash' && String(body.messages?.[0]?.content).includes('JSON array')
            ? '["ollama clef api docs"]'
            : `Brief from ${body.model}: [Doc A](https://example.com/a)`
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('Not found', { status: 404 })
    }) as typeof fetch

    const searchRes = await ollamaWebSearch({
      query: 'clef systemone',
      apiKey: 'test-ollama-key',
      semaphore: new AsyncSemaphore(3),
      fetchFn: mockWebFetch,
    })
    assert.equal(searchRes.sources.length, 2)

    const clefQuick = await consultClefAdvisor({
      query: 'quick fact',
      candidates: searchRes.sources,
      apiKey: 'test-ollama-key',
      semaphore: new AsyncSemaphore(3),
      fetchFn: mockWebFetch,
    })
    assert.equal(clefQuick.routeTier, 'snippet_sufficient')
    assert.deepEqual(clefQuick.selectedIndices, [0])

    const deepRes = await runKimiClawDeepResearch(
      { query: 'full spec comparison', mode: 'balanced' },
      { apiKey: 'test-ollama-key', fetchFn: mockWebFetch },
    )
    assert.ok(deepRes.modelsUsed.includes('clef'))
    assert.ok(deepRes.modelsUsed.includes('glm-5.3-flash'))
    assert.ok(deepRes.modelsUsed.includes('kimi-k2.7-code'))
    assert.match(deepRes.brief, /Doc A/)

    let registeredSearch: string | undefined
    let registeredFetch: string | undefined
    const dispWeb = registerOllamaWebProviders(
      {
        registerSearchProvider: (p) => {
          registeredSearch = p.id
        },
        registerFetchProvider: (p) => {
          registeredFetch = p.id
        },
      },
      { apiKey: 'test-ollama-key', fetchFn: mockWebFetch },
    )
    assert.equal(registeredSearch, 'ollama-kimi')
    assert.equal(registeredFetch, 'ollama-fetch')
    dispWeb()

    // 9. Resumed-session seq seeding avoids replaying 500 historical events at turn-stopping
    const resumedEvents = [
      ...Array.from({ length: 498 }, (_, i) => ({
        seq: i,
        type: i % 2 === 0 ? 'user/message' : 'assistant/message',
        time: Date.now() - 10_000,
        data: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `Old msg ${i}` }] },
      })),
      {
        seq: 499,
        type: 'user/message',
        time: Date.now(),
        data: { id: 'res-u', role: 'user', content: [{ type: 'text', text: 'Continue research-123 checks' }], source: { kind: 'user' } },
      },
    ]
    const resumedAgent = {
      id: 'dsh-coder',
      session: {
        id: 'dsh-resumed-500',
        seq: 500,
        header: { cwd: 'C:/Users/lenovo/workspaces/research-123' },
        snapshotEvents(fromSeq = 0) {
          return resumedEvents.filter((e) => e.seq >= fromSeq)
        },
      },
    }
    const beforeResumedCaptures = orch.getStats().captureMessages
    await preStep(
      { agent: resumedAgent, messages: [resumedEvents[resumedEvents.length - 1].data], turn: 20, step: 0 },
      async () => ({ kind: 'enter', messages: [resumedEvents[resumedEvents.length - 1].data] }),
    )
    resumedEvents.push({
      seq: 500,
      type: 'assistant/message',
      time: Date.now(),
      data: { role: 'assistant', content: [{ type: 'text', text: 'Resumed reply' }] } as any,
    })
    resumedAgent.session.seq = 501
    await handlers.get('agent/turn-stopping')!({ agent: resumedAgent, turn: 20 })
    const resumedCapturedDelta = orch.getStats().captureMessages - beforeResumedCaptures
    assert.ok(resumedCapturedDelta >= 1 && resumedCapturedDelta <= 4, `expected <=4 captured on resume, got ${resumedCapturedDelta}`)

    // 10. Ordered 3-tier Ollama Cloud fallback on agent/request-error
    const selectedModels: Array<{ provider: string; model: string }> = []
    const errHandler = handlers.get('agent/request-error')!
    assert.ok(errHandler, 'Missing agent/request-error handler')
    const failoverAgent = {
      id: 'dsh-failover',
      session: { id: 'ses-failover' },
      model: {
        select(target: { provider: string; model: string }) {
          selectedModels.push({ provider: target.provider, model: target.model })
        },
      },
    }
    for (let tier = 0; tier < 3; tier += 1) {
      await errHandler(
        { agent: failoverAgent, provider: 'ollama', failure: { code: 'RATE_LIMIT', statusCode: 429 } },
        async () => undefined,
      )
    }
    assert.deepEqual(selectedModels, [
      { provider: 'ollama', model: 'deepseek-v4.1-flash' },
      { provider: 'ollama', model: 'glm-5.3-flash' },
      { provider: 'ollama', model: 'minimax-m3.1-flash' },
    ])
  } finally {
    await handlers.get('dispose')?.()
    for (const d of disposers) d()
    rmSync(tmp, { recursive: true, force: true })
  }
})
