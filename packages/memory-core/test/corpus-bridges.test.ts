import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  clearCachedHfTokenForTest,
  codespaceExec,
  codespaceStatus,
  codespaceSync,
  EXCLUDED_ISOLATED_SIDS,
  hfVaultList,
  hfVaultStatus,
  hfVaultUpload,
  InMemoryEverosEngine,
  InMemoryGBrainStore,
  MemoryOrchestrator,
  opencodeSessionRead,
  opencodeSessionSearch,
  resetAutoHealCooldownForTest,
  runStartupPreflight,
  triggerEnsureStackDetached,
  YESTERDAY_OPENCODE_SESSION_ID,
} from '../src/index.ts'

test('opencodeSessionSearch & opencodeSessionRead search yesterday_session, manifest & opencode.db with Q-6 redaction and Antigravity isolation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-bridge-'))
  try {
    const ysDir = join(dir, 'yesterday_session')
    mkdirSync(ysDir, { recursive: true })
    const fakeGh = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz123456'
    const jsonlRows = [
      {
        session_id: YESTERDAY_OPENCODE_SESSION_ID,
        seq: 0,
        role: 'user',
        time_created: 1790165070731,
        text: `Check DiffPure purification and calibration_ffhq_sfhq with token ${fakeGh}`,
      },
      {
        session_id: YESTERDAY_OPENCODE_SESSION_ID,
        seq: 1,
        role: 'assistant',
        time_created: 1790165075000,
        parts: [{ type: 'text', text: 'GFPGANv1.4.pth restored in kyc-injection-framework/weights.' }],
      },
    ]
    writeFileSync(
      join(ysDir, 'yesterday_session_messages.jsonl'),
      jsonlRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    )
    writeFileSync(
      join(ysDir, 'yesterday_session_files_manifest.json'),
      JSON.stringify({
        session_id: YESTERDAY_OPENCODE_SESSION_ID,
        forks: ['ses_ec679a420ffeC8RTquVGLT1osF'],
        total_unique_paths_referenced: 2262,
        total_kaggle_slugs_referenced: 41,
        total_urls_referenced: 713,
        kaggle_slugs: ['kelvinkitonyi/scale-xl-b2', 'meshachmaluki/kyc-a6-diffpure-purification'],
        by_category: {
          reports: [{ path: 'data/reports/realism_baseline.json', mention_count: 5 }],
        },
      }),
      'utf8',
    )

    // Create minimal opencode.db with 1 normal + 1 isolated Antigravity session
    const dbPath = join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, slug TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    `)
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
      'ses_normal_01',
      'normal-01',
      'C:/Users/lenovo/workspaces/research-123',
      'KYC Step 8 FastAPI Fix',
      1790000000000,
      1790000005000,
    )
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm1',
      'ses_normal_01',
      'assistant',
      0,
      1790000001000,
      1790000001000,
      JSON.stringify({ role: 'assistant', content: `FastAPI wsproto alembic check passed (${fakeGh})` }),
    )
    const [excludedSid] = [...EXCLUDED_ISOLATED_SIDS]
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
      excludedSid,
      'anti-sync',
      'C:/Users/lenovo/my_obsidian_vault/antigravity-history-sync',
      'Isolated Obsidian Antigravity Session',
      1790000000000,
      1790000005000,
    )
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'm2',
      excludedSid,
      'user',
      0,
      1790000001000,
      1790000001000,
      JSON.stringify({ role: 'user', content: 'FastAPI secret obsidian note' }),
    )
    db.close()

    const s1 = opencodeSessionSearch({
      query: 'DiffPure realism_baseline',
      yesterdayDir: ysDir,
      opencodeDbPath: dbPath,
      corpusPath: join(dir, 'missing.jsonl'),
    })
    assert.ok(s1.totalMatches >= 2)
    assert.ok(s1.results.some((r) => r.source === 'yesterday_session'))
    assert.ok(s1.results.some((r) => r.source === 'manifest'))
    assert.ok(!JSON.stringify(s1).includes(fakeGh), 'Q-6 secret must be redacted')

    const s2 = opencodeSessionSearch({
      query: 'FastAPI wsproto',
      yesterdayDir: ysDir,
      opencodeDbPath: dbPath,
      corpusPath: join(dir, 'missing.jsonl'),
    })
    assert.ok(s2.results.some((r) => r.sessionId === 'ses_normal_01'))
    assert.ok(!s2.results.some((r) => r.sessionId === excludedSid), 'Isolated Antigravity/Obsidian session must be excluded')
    assert.ok(!JSON.stringify(s2).includes(fakeGh))

    const r1 = opencodeSessionRead({ sessionId: 'yesterday', offset: 0, limit: 1, yesterdayDir: ysDir, opencodeDbPath: dbPath })
    assert.equal(r1.totalRows, 2)
    assert.equal(r1.hasMore, true)
    assert.equal(r1.nextOffset, 1)
    assert.match(r1.rows[0].text, /\[REDACTED:GITHUB_TOKEN\]/)

    const rBlocked = opencodeSessionRead({ sessionId: excludedSid, yesterdayDir: ysDir, opencodeDbPath: dbPath })
    assert.equal(rBlocked.excluded, true)
    assert.equal(rBlocked.rows.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codespace & hf_vault bridges redact secrets, fail-close on sensitive files, and inject Windows UTF-8 env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-remote-'))
  try {
    const fakeHf = 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz998877'
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined> }> = []
    const mockRunner = async (
      cmd: string,
      args: string[],
      opts?: { env?: Record<string, string | undefined> },
    ) => {
      calls.push({ cmd, args, env: opts?.env })
      if (cmd === 'gh' && args[1] === 'view') {
        return { stdout: JSON.stringify({ state: 'Available' }), stderr: '', exitCode: 0 }
      }
      if (cmd === 'gh' && args[1] === 'ssh') {
        return { stdout: `ok token=${fakeHf}`, stderr: '', exitCode: 0 }
      }
      if (cmd === 'python') {
        const script = args[1] ?? ''
        assert.match(script, /sys\.stdout\.reconfigure\(encoding="utf-8"/)
        if (script.includes('list_repo_files')) {
          return { stdout: JSON.stringify({ total: 2, files: ['vault/a.txt', `vault/${fakeHf}.txt`] }), stderr: '', exitCode: 0 }
        }
        return { stdout: JSON.stringify({ private: true, lastModified: '2026-11-14', fileCount: 12 }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    const cs = await codespaceStatus({
      runner: mockRunner,
      fetchFn: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    })
    assert.equal(cs.codespaceState, 'Available')
    assert.equal(cs.endpoints.everos.ok, true)

    const ce = await codespaceExec({ cmd: 'echo hi', runner: mockRunner })
    assert.equal(ce.exitCode, 0)
    assert.match(ce.stdout, /\[REDACTED:HF_TOKEN\]/)
    assert.ok(!ce.stdout.includes(fakeHf))

    const blockedSync = await codespaceSync({ direction: 'up', path: join(dir, '.env'), runner: mockRunner })
    assert.equal(blockedSync.exitCode, 1)
    assert.match(blockedSync.output, /Blocked upload/i)

    const hfl = await hfVaultList({ runner: mockRunner })
    assert.equal(hfl.totalFiles, 2)
    assert.ok(!JSON.stringify(hfl.files).includes(fakeHf))

    const hfs = await hfVaultStatus({ runner: mockRunner })
    assert.equal(hfs.reachable, true)
    assert.equal(hfs.fileCount, 12)

    const secretFile = join(dir, 'leak.txt')
    writeFileSync(secretFile, `token=${fakeHf}`, 'utf8')
    const blockedUpload = await hfVaultUpload({ localPath: secretFile, runner: mockRunner })
    assert.equal(blockedUpload.ok, false)
    assert.match(blockedUpload.error ?? '', /unredacted secret/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runStartupPreflight writes startup-preflight.json, dsh-plugin.log & pre-warms HybridRetrievalIndex semantic fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-preflight-'))
  try {
    const corpusPath = join(dir, 'ingested-corpus.jsonl')
    writeFileSync(
      corpusPath,
      JSON.stringify({
        id: 'ses_f31d8cd0:turn:1',
        session_id: YESTERDAY_OPENCODE_SESSION_ID,
        workspace: 'research-123',
        title: 'Yesterday session stopped by network issues',
        speaker_role: 'assistant',
        category: 'dataset_recovery',
        text: 'Restored 1,175 accepted corpus images and Kaggle dual-T4 DiffPure evaluation baseline.',
      }) + '\n',
      'utf8',
    )
    const cpPath = join(dir, 'ingest-checkpoint.json')
    writeFileSync(
      cpPath,
      JSON.stringify({
        summary: {
          opencode_target: 81,
          opencode_ingested_ok: 81,
          opencode_flushed_ok: 81,
          dsh_audit_8a1d60a0_ok: true,
          yesterday_manifest_ok: true,
          gbrain_pages_ok: 120,
          local_corpus_records: 1,
        },
      }),
      'utf8',
    )
    const ysDir = join(dir, 'yesterday_session')
    mkdirSync(ysDir, { recursive: true })
    writeFileSync(join(ysDir, 'yesterday_session_messages.jsonl'), '{"seq":0,"role":"user","text":"hello"}\n', 'utf8')
    writeFileSync(
      join(ysDir, 'yesterday_session_files_manifest.json'),
      JSON.stringify({ session_id: YESTERDAY_OPENCODE_SESSION_ID, total_unique_paths_referenced: 2262 }),
      'utf8',
    )

    const preflightOut = join(dir, 'startup-preflight.json')
    const logOut = join(dir, 'dsh-plugin.log')
    const appCtxPath = join(dir, 'app-session-context.json')

    const everos = new InMemoryEverosEngine()
    const gbrain = new InMemoryGBrainStore([])

    const res = await runStartupPreflight({
      everos,
      gbrain,
      evergreenDir: dir,
      corpusPath,
      checkpointPath: cpPath,
      yesterdayDir: ysDir,
      appContextPath: appCtxPath,
      preflightOutputPath: preflightOut,
      pluginLogPath: logOut,
    })

    assert.equal(res.report.status, 'ready')
    assert.ok(res.report.localIndex.indexedDocs >= 1)
    assert.equal(res.report.yesterdaySession.messageRowCount, 1)
    assert.ok(existsSync(preflightOut))
    assert.ok(existsSync(logOut))
    const written = JSON.parse(readFileSync(preflightOut, 'utf8'))
    assert.equal(written.status, 'ready')

    // Verify MemoryOrchestrator uses pre-warmed localIndex even when EverOS/GBrain return 0 hits
    const orch = new MemoryOrchestrator({
      config: { appId: 'dsh', appContextPath: appCtxPath },
      everos,
      gbrain,
      localIndex: res.localIndex,
    })
    try {
      const recalled = await orch.recall({
        query: 'Kaggle dual-T4 DiffPure accepted corpus images',
        cwd: 'C:/Users/lenovo/workspaces/research-123',
        sessionId: 'smoke-1',
      })
      assert.ok(recalled.items.some((i) => i.source === 'local-hybrid'))
      assert.match(recalled.block, /DiffPure/)
    } finally {
      orch.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hfVaultList skips stale 401 token and succeeds with valid .env fallback token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-hftok-'))
  const prevEnv = process.env.HF_TOKEN
  clearCachedHfTokenForTest()
  try {
    const staleTok = 'hf_stale401token0000000000000000000'
    const validTok = 'hf_valid200token1111111111111111111'
    process.env.HF_TOKEN = staleTok
    const envFile = join(dir, '.env')
    writeFileSync(envFile, `HF_TOKEN="${validTok}"\n`, 'utf8')

    const seenAuthHeaders: string[] = []
    const res = await hfVaultList({
      envPaths: [envFile],
      runner: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      fetchFn: async (_url, init) => {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
        seenAuthHeaders.push(auth)
        if (auth === `Bearer ${validTok}`) {
          return new Response(JSON.stringify([{ type: 'file', path: 'vault/archive.zip' }]), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'Invalid username or password.' }), { status: 401 })
      },
    })

    assert.equal(res.totalFiles, 1)
    assert.deepEqual(res.files, ['vault/archive.zip'])
    assert.ok(seenAuthHeaders.includes(`Bearer ${staleTok}`))
    assert.ok(seenAuthHeaders.includes(`Bearer ${validTok}`))
  } finally {
    clearCachedHfTokenForTest()
    if (prevEnv === undefined) delete process.env.HF_TOKEN
    else process.env.HF_TOKEN = prevEnv
    rmSync(dir, { recursive: true, force: true })
  }
})

test('triggerEnsureStackDetached & runStartupPreflight auto-heal spawn detached UTF-8 ensure_stack.py with cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-heal-'))
  resetAutoHealCooldownForTest()
  try {
    const scriptPath = join(dir, 'ensure_stack.py')
    writeFileSync(scriptPath, '# dummy\n', 'utf8')

    const spawns: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
    let unrefCount = 0
    const mockSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawns.push({ cmd, args, opts })
      return {
        unref() {
          unrefCount += 1
        },
      }
    }) as unknown as NonNullable<Parameters<typeof triggerEnsureStackDetached>[0]>['spawnFn']

    const failingEveros = {
      async health() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
      },
      async add() {
        throw new Error('down')
      },
      async flush() {
        throw new Error('down')
      },
      async search() {
        return { results: [] }
      },
    }
    const failingGbrain = {
      async health() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3131')
      },
      async query() {
        return []
      },
      async putPage() {
        return { ok: false }
      },
    }

    await runStartupPreflight({
      everos: failingEveros,
      gbrain: failingGbrain,
      everosUrl: 'http://127.0.0.1:8000',
      gbrainUrl: 'http://127.0.0.1:3131',
      evergreenDir: dir,
      autoHeal: true,
      ensureStackScriptPath: scriptPath,
      spawnFn: mockSpawn,
    })

    assert.equal(spawns.length, 1)
    assert.equal(unrefCount, 1)
    assert.ok(spawns[0]!.args.includes(scriptPath))
    assert.ok(spawns[0]!.args.includes('--ensure'))
    assert.equal(spawns[0]!.opts.detached, true)
    assert.equal(spawns[0]!.opts.windowsHide, true)
    const env = spawns[0]!.opts.env as Record<string, string>
    assert.equal(env.PYTHONIOENCODING, 'utf-8')
    assert.equal(env.PYTHONUTF8, '1')

    // Second trigger within cooldown is suppressed
    const second = triggerEnsureStackDetached({
      evergreenDir: dir,
      ensureStackScriptPath: scriptPath,
      spawnFn: mockSpawn,
    })
    assert.equal(second.triggered, false)
    assert.equal(second.reason, 'cooldown_active')
  } finally {
    resetAutoHealCooldownForTest()
    rmSync(dir, { recursive: true, force: true })
  }
})
