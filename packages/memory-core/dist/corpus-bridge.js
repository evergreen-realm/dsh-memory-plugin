/** Local Corpus, Yesterday Session (5,341 rows), and OpenCode DB (81 sessions) bridge (Phase D). */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sanitizeScopeId } from './everos-client.js'
import { redactSecrets } from './redactor.js'
import { tokenizeText,                 } from './retrieval.js'

function deriveProjectIdFromDir(dir         )         {
  if (!dir) return 'default'
  return sanitizeScopeId(basename(resolve(dir)) || 'workspace', 'workspace')
}

export const YESTERDAY_OPENCODE_SESSION_ID = 'ses_f31d8cd0dffeigmeSZY42Gqr2F'
export const YESTERDAY_FORK_SESSION_IDS                    = [
  'ses_ec679a420ffeC8RTquVGLT1osF',
  'ses_ec68829dfffeAqj9Xe6wnG664e',
]
export const DSH_AUDIT_SESSION_ID = 'session-8a1d60a0-f6ba-42bb-b289-d39f03cf82d3'
export const EXCLUDED_ISOLATED_SIDS = new Set([
  'ses_e87df7e8affeZSQrSszlExyRT8',
  'ses_e87df00a3ffeHsh90mP6diVX8O',
])
const ISOLATED_PATTERNS = ['antigravity', 'my_obsidian_vault', 'antigravity-history-sync']

export function isIsolatedSession(sessionId         , directory         )          {
  if (sessionId && EXCLUDED_ISOLATED_SIDS.has(sessionId)) return true
  const hay = `${sessionId ?? ''} ${directory ?? ''}`.toLowerCase()
  return ISOLATED_PATTERNS.some((p) => hay.includes(p))
}

export function resolveEvergreenDir(overrideDir         )         {
  return overrideDir || process.env.EVERGREEN_MEMORY_DIR || join(homedir(), '.evergreen-memory')
}

export function resolveOpencodeDbPath(overridePath         )         {
  return overridePath || process.env.OPENCODE_DB_PATH || join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

export function resolveYesterdaySessionDir(options    
                      
                  
                     
 )                     {
  const dshHome = options?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const researchWs = options?.researchWs || process.env.RESEARCH_123_WS || join(homedir(), 'workspaces', 'research-123')
  const candidates = [
    options?.overrideDir,
    process.env.YESTERDAY_SESSION_DIR,
    join(dshHome, 'sessions', '--C-Users-lenovo-workspaces-research-123--', DSH_AUDIT_SESSION_ID, 'yesterday_session'),
    join(dshHome, 'sessions', DSH_AUDIT_SESSION_ID, 'yesterday_session'),
    join(researchWs, 'yesterday_session'),
  ].filter((x)              => Boolean(x))

  for (const dir of candidates) {
    if (existsSync(join(dir, 'yesterday_session_messages.jsonl')) || existsSync(join(dir, 'yesterday_session_files_manifest.json'))) {
      return dir
    }
  }
  return undefined
}

export function resolveResearchWorkspaceSessionCount(dshHome         )                                                       {
  const root = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const wsDir = join(root, 'sessions', '--C-Users-lenovo-workspaces-research-123--')
  const candidate = join(wsDir, 'workspace.json')
  if (existsSync(candidate)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))                                                    
      const count = Array.isArray(parsed.sessions)
        ? parsed.sessions.length
        : Array.isArray(parsed.sessionIds)
          ? parsed.sessionIds.length
          : 0
      if (count > 0) return { sessionCount: count, workspaceJsonPath: candidate }
    } catch {
      // Fall through to counting session-* subdirectories.
    }
  }
  if (!existsSync(wsDir)) return { sessionCount: 0 }
  try {
    const dirs = readdirSync(wsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('session-'),
    )
    return { sessionCount: dirs.length, workspaceJsonPath: existsSync(candidate) ? candidate : wsDir }
  } catch {
    return { sessionCount: 0 }
  }
}

                                          
                
              
                         
                          
                             
                             
                      
                               
 

export function inspectYesterdaySession(options    
                      
                  
                     
 )                          {
  const dir = resolveYesterdaySessionDir(options)
  const ws = resolveResearchWorkspaceSessionCount(options?.dshHome)
  if (!dir) {
    return {
      found: false,
      messageRowCount: 0,
      manifestPresent: false,
      manifestUniquePaths: 0,
      manifestKaggleSlugs: 0,
      manifestUrls: 0,
      workspaceSessionCount: ws.sessionCount,
    }
  }

  let messageRowCount = 0
  const jsonlPath = join(dir, 'yesterday_session_messages.jsonl')
  if (existsSync(jsonlPath)) {
    const raw = readFileSync(jsonlPath, 'utf8')
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) messageRowCount++
    }
    if (raw.length > 0 && raw.charCodeAt(raw.length - 1) !== 10) messageRowCount++
  }

  let manifestPresent = false
  let manifestUniquePaths = 0
  let manifestKaggleSlugs = 0
  let manifestUrls = 0
  const mfPath = join(dir, 'yesterday_session_files_manifest.json')
  if (existsSync(mfPath)) {
    manifestPresent = true
    try {
      const mf = JSON.parse(readFileSync(mfPath, 'utf8'))                           
      manifestUniquePaths = Number(mf.total_unique_paths_referenced ?? 0)
      manifestKaggleSlugs = Number(mf.total_kaggle_slugs_referenced ?? 0)
      manifestUrls = Number(mf.total_urls_referenced ?? 0)
    } catch {
      // Keep manifestPresent=true with zeroed counts
    }
  }

  return {
    found: messageRowCount > 0 || manifestPresent,
    dir,
    messageRowCount,
    manifestPresent,
    manifestUniquePaths,
    manifestKaggleSlugs,
    manifestUrls,
    workspaceSessionCount: ws.sessionCount,
  }
}

                               
            
                    
                    
                
                       
                     
                   
                   
                   
                    
                          
              
 

export function loadCorpusDocuments(options    
                     
                       
                  
 )                                                                    {
  const corpusPath = options?.corpusPath || join(resolveEvergreenDir(), 'ingested-corpus.jsonl')
  const maxDocs = options?.maxDocs ?? 3000
  const docs               = []
  let totalLines = 0
  let redactedCount = 0

  if (existsSync(corpusPath)) {
    const lines = readFileSync(corpusPath, 'utf8').split(/\r?\n/)
    for (const ln of lines) {
      if (!ln.trim()) continue
      totalLines++
      if (docs.length >= maxDocs) continue
      try {
        const rec = JSON.parse(ln)                
        if (!rec.text || isIsolatedSession(rec.session_id, rec.workspace)) continue
        const red = redactSecrets(rec.text)
        redactedCount += red.redactedCount
        const tsDate =
          typeof rec.timestamp === 'number' && rec.timestamp > 1000
            ? new Date(rec.timestamp > 1e12 ? rec.timestamp : rec.timestamp * 1000).toISOString().slice(0, 10)
            : undefined
        docs.push({
          id: rec.id || `corpus:${totalLines}`,
          title: rec.title || rec.session_id || 'Corpus Turn',
          text: red.text.slice(0, 2400),
          project_id: rec.workspace || 'opencode-control-center',
          app_id: 'import-opencode',
          date: tsDate,
          source_tier: 2,
          owner_type: rec.owner_type === 'user' || rec.speaker_role === 'user' ? 'user' : 'agent',
          tags: [rec.category ?? 'general_engineering', ...(rec.topics ?? []), ...(rec.touched_files ?? []).slice(0, 4)],
        })
      } catch {
        // Ignore malformed line
      }
    }
  }

  // Always include manifest overview + key yesterday_session anchor if jsonl absent or small
  const ysDir = resolveYesterdaySessionDir({ overrideDir: options?.yesterdayDir })
  if (ysDir) {
    const mfPath = join(ysDir, 'yesterday_session_files_manifest.json')
    if (existsSync(mfPath)) {
      try {
        const mf = JSON.parse(readFileSync(mfPath, 'utf8'))                           
        const slugs = Array.isArray(mf.kaggle_slugs) ? mf.kaggle_slugs.slice(0, 20).join(', ') : ''
        const red = redactSecrets(
          `Yesterday session manifest (${String(mf.session_id ?? YESTERDAY_OPENCODE_SESSION_ID)}): ` +
            `${String(mf.total_unique_paths_referenced ?? 0)} unique file paths, ` +
            `${String(mf.total_kaggle_slugs_referenced ?? 0)} Kaggle slugs (${slugs}), ` +
            `${String(mf.total_urls_referenced ?? 0)} URLs. Forks: ${Array.isArray(mf.forks) ? mf.forks.join(', ') : ''}`,
        )
        redactedCount += red.redactedCount
        docs.push({
          id: 'manifest:yesterday_session_files',
          title: 'Yesterday Session Files Manifest (2,262 paths)',
          text: red.text,
          project_id: 'research-123',
          source_tier: 1,
          owner_type: 'agent',
          tags: ['manifest', 'dataset_recovery', 'research-123', 'kaggle'],
        })
      } catch {
        // Ignore
      }
    }

    // If ingested-corpus.jsonl was missing, fall back to indexing sampled + recent yesterday_session_messages.jsonl rows
    if (docs.length < 50 && existsSync(join(ysDir, 'yesterday_session_messages.jsonl'))) {
      const rawLines = readFileSync(join(ysDir, 'yesterday_session_messages.jsonl'), 'utf8').split(/\r?\n/)
      let sampled = 0
      for (let i = 0; i < rawLines.length && sampled < 1200; i++) {
        const ln = rawLines[i]
        if (!ln.trim()) continue
        if (rawLines.length > 1200 && i > 200 && i < rawLines.length - 600 && i % 4 !== 0) continue
        try {
          const row = JSON.parse(ln)                           
          const txt = extractYesterdayRowText(row)
          if (!txt) continue
          const red = redactSecrets(txt)
          redactedCount += red.redactedCount
          docs.push({
            id: `yesterday:row:${String(row.seq ?? i)}`,
            title: `Yesterday session row ${String(row.seq ?? i)}`,
            text: red.text.slice(0, 2000),
            project_id: 'research-123',
            app_id: 'import-opencode',
            source_tier: 2,
            owner_type: row.role === 'user' ? 'user' : 'agent',
            tags: ['yesterday_session', 'research-123', YESTERDAY_OPENCODE_SESSION_ID],
          })
          sampled++
        } catch {
          // Ignore malformed row
        }
      }
    }
  }

  return { docs, totalLines, redactedCount }
}

function extractYesterdayRowText(row                         )         {
  const parts           = []
  if (typeof row.text === 'string' && row.text.trim()) parts.push(row.text.trim())
  if (typeof row.content === 'string' && row.content.trim()) parts.push(row.content.trim())
  if (typeof row.summary === 'string' && row.summary.trim()) parts.push(row.summary.trim())
  if (Array.isArray(row.content)) {
    for (const c of row.content) {
      if (c && typeof c === 'object' && typeof (c                           ).text === 'string') {
        parts.push(String((c                           ).text))
      }
    }
  }
  if (Array.isArray(row.parts)) {
    for (const p of row.parts) {
      if (p && typeof p === 'object') {
        const pr = p                           
        if (typeof pr.text === 'string' && pr.text.trim()) parts.push(pr.text.trim())
        else if (typeof pr.tool === 'string') parts.push(`[tool:${pr.tool}]`)
      }
    }
  }
  return parts.join('\n').trim()
}

function extractOpenCodeBlobText(rawJson        , extraParts           )                                 {
  let obj                          = {}
  try {
    obj = JSON.parse(rawJson)                           
  } catch {
    return { role: 'assistant', text: rawJson.trim() }
  }
  const role = String(obj.role ?? (obj.type === 'user' ? 'user' : 'assistant'))
  const chunks           = []
  if (typeof obj.text === 'string' && obj.text.trim()) chunks.push(obj.text.trim())
  if (typeof obj.summary === 'string' && obj.summary.trim()) chunks.push(obj.summary.trim())
  if (typeof obj.content === 'string' && obj.content.trim()) chunks.push(obj.content.trim())
  else if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && typeof item === 'object') {
        const it = item                           
        if (typeof it.text === 'string' && it.text.trim()) chunks.push(it.text.trim())
        else if (typeof it.output === 'string' && it.output.trim()) chunks.push(it.output.trim().slice(0, 600))
      }
    }
  }
  if (Array.isArray(obj.parts)) {
    for (const p of obj.parts) {
      if (p && typeof p === 'object') {
        const pr = p                           
        if (typeof pr.text === 'string' && pr.text.trim()) chunks.push(pr.text.trim())
      }
    }
  }
  if (extraParts) {
    for (const rp of extraParts) {
      try {
        const pr = JSON.parse(rp)                           
        if (typeof pr.text === 'string' && pr.text.trim()) chunks.push(pr.text.trim())
      } catch {
        // Ignore
      }
    }
  }
  return { role, text: chunks.join('\n').trim() }
}

                     
                        
 

function openSqliteQuery(dbPath        , sql        , params                         = [])              {
  if (!existsSync(dbPath)) return []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('node:sqlite')                                                                                                                                                                
    const db = new mod.DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all(...params)
    } finally {
      db.close()
    }
  } catch {
    // Fallback to python3 sqlite3 with mandatory Windows UTF-8 dual fix
    const py = [
      'import json, sqlite3, sys',
      'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
      'sys.stderr.reconfigure(encoding="utf-8", errors="replace")',
      'conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)',
      'conn.row_factory = sqlite3.Row',
      'rows = [dict(r) for r in conn.execute(sys.argv[2], json.loads(sys.argv[3])).fetchall()]',
      'print(json.dumps(rows, ensure_ascii=False))',
    ].join('\n')
    try {
      const out = execFileSync('python', ['-c', py, dbPath, sql, JSON.stringify(params)], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      return JSON.parse(out)               
    } catch {
      return []
    }
  }
}

                                   
                   
               
                   
              
             
                
                                                                     
               
                 
 

                                      
               
                    
                      
                           
                              
                             
                        
 

function scoreSnippet(text        , queryLower        , terms          )         {
  const low = text.toLowerCase()
  let score = 0
  if (queryLower.length >= 3 && low.includes(queryLower)) score += 10
  for (const t of terms) {
    if (t.length >= 2 && low.includes(t)) score += 2
  }
  return score
}

function makeSnippet(text        , queryLower        , terms          , maxLen = 480)         {
  const low = text.toLowerCase()
  let anchor = queryLower ? low.indexOf(queryLower) : -1
  if (anchor < 0) {
    for (const t of terms) {
      const idx = low.indexOf(t)
      if (idx >= 0) {
        anchor = idx
        break
      }
    }
  }
  if (anchor < 0 || text.length <= maxLen) return text.slice(0, maxLen)
  const start = Math.max(0, anchor - Math.floor(maxLen / 3))
  const prefix = start > 0 ? '...' : ''
  const suffix = start + maxLen < text.length ? '...' : ''
  return `${prefix}${text.slice(start, start + maxLen)}${suffix}`
}

export function opencodeSessionSearch(params   
               
                    
                
                         
                       
                     
 )                      {
  const limit = Math.max(1, Math.min(50, params.limit ?? 10))
  if (params.sessionId && isIsolatedSession(params.sessionId)) {
    return {
      query: params.query,
      sessionId: params.sessionId,
      totalMatches: 0,
      searchedSources: [],
      redactedSecretsCount: 0,
      results: [],
      blockedReason: 'Session is strictly isolated (Antigravity Sync / my_obsidian_vault exclusion, Q-6).',
    }
  }

  const queryLower = params.query.trim().toLowerCase()
  const terms = tokenizeText(params.query)
  const hits                     = []
  const searchedSources           = []
  let redactedSecretsCount = 0

  // 1. Search all 5,341 rows of Yesterday session + manifest
  const ysDir = resolveYesterdaySessionDir({ overrideDir: params.yesterdayDir })
  const wantYesterday =
    !params.sessionId ||
    params.sessionId === YESTERDAY_OPENCODE_SESSION_ID ||
    params.sessionId === 'yesterday' ||
    params.sessionId === 'yesterday_session'

  if (ysDir && wantYesterday) {
    const jsonlPath = join(ysDir, 'yesterday_session_messages.jsonl')
    if (existsSync(jsonlPath)) {
      searchedSources.push('yesterday_session_messages.jsonl')
      const lines = readFileSync(jsonlPath, 'utf8').split(/\r?\n/)
      for (let idx = 0; idx < lines.length; idx++) {
        const ln = lines[idx]
        if (!ln.trim()) continue
        const low = ln.toLowerCase()
        if (terms.length > 0 && !terms.some((t) => low.includes(t)) && !low.includes(queryLower)) continue
        try {
          const row = JSON.parse(ln)                           
          const txt = extractYesterdayRowText(row)
          if (!txt) continue
          const sc = scoreSnippet(txt, queryLower, terms)
          if (sc <= 0) continue
          const red = redactSecrets(makeSnippet(txt, queryLower, terms))
          redactedSecretsCount += red.redactedCount
          hits.push({
            sessionId: String(row.session_id ?? YESTERDAY_OPENCODE_SESSION_ID),
            title: 'Yesterday session stopped by network issues',
            projectId: 'research-123',
            role: String(row.role ?? 'assistant'),
            seq: Number(row.seq ?? idx),
            offset: idx,
            source: 'yesterday_session',
            score: sc,
            snippet: red.text,
          })
        } catch {
          // Ignore
        }
      }
    }

    const mfPath = join(ysDir, 'yesterday_session_files_manifest.json')
    if (existsSync(mfPath)) {
      searchedSources.push('yesterday_session_files_manifest.json')
      try {
        const mf = JSON.parse(readFileSync(mfPath, 'utf8'))                           
        const byCat = (mf.by_category ?? {})                                                  
        for (const [cat, entries] of Object.entries(byCat)) {
          if (!Array.isArray(entries)) continue
          for (let i = 0; i < entries.length; i++) {
            const p = String(entries[i]?.path ?? '')
            const mapped = entries[i]?.mapped_windows_path ? ` -> ${String(entries[i].mapped_windows_path)}` : ''
            const line = `[manifest:${cat}] ${p}${mapped}`
            const sc = scoreSnippet(line, queryLower, terms)
            if (sc > 0) {
              const red = redactSecrets(line)
              redactedSecretsCount += red.redactedCount
              hits.push({
                sessionId: YESTERDAY_OPENCODE_SESSION_ID,
                title: 'yesterday_session_files_manifest.json',
                projectId: 'research-123',
                role: 'manifest',
                seq: i,
                offset: i,
                source: 'manifest',
                score: sc,
                snippet: red.text,
              })
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // 2. Search all 81 non-Antigravity OpenCode sessions in opencode.db
  const dbPath = resolveOpencodeDbPath(params.opencodeDbPath)
  if (existsSync(dbPath)) {
    searchedSources.push('opencode.db')
    const sessionRows = params.sessionId
      ? openSqliteQuery(dbPath, 'SELECT id, slug, directory, title FROM session_v2 WHERE id = ?', [params.sessionId])
      : openSqliteQuery(dbPath, 'SELECT id, slug, directory, title FROM session_v2 ORDER BY time_updated DESC', [])

    const sessionMap = new Map                                                                 ()
    for (const s of sessionRows) {
      const sid = String(s.id ?? '')
      const dir = String(s.directory ?? '')
      if (!sid || isIsolatedSession(sid, dir)) continue
      sessionMap.set(sid, {
        title: String(s.title ?? s.slug ?? sid),
        directory: dir,
        projectId: deriveProjectIdFromDir(dir),
      })
    }

    if (sessionMap.size > 0) {
      // Push SQL LIKE pre-filter for first meaningful term so 17k rows stay fast
      const anchorTerm = terms.find((t) => t.length >= 3) ?? params.query.trim()
      const likePat = `%${anchorTerm.replace(/[%_]/g, '')}%`
      const sidFilterSql = params.sessionId ? ' AND session_id = ?' : ''
      const queryParams                         = params.sessionId ? [likePat, params.sessionId] : [likePat]

      const msgRows = openSqliteQuery(
        dbPath,
        `SELECT session_id, seq, data FROM session_message WHERE LOWER(data) LIKE LOWER(?)${sidFilterSql} ORDER BY time_created ASC, seq ASC LIMIT 400`,
        queryParams,
      )
      for (let i = 0; i < msgRows.length; i++) {
        const r = msgRows[i]
        const sid = String(r.session_id ?? '')
        const meta = sessionMap.get(sid)
        if (!meta) continue
        const { role, text } = extractOpenCodeBlobText(String(r.data ?? ''))
        if (!text) continue
        const sc = scoreSnippet(text, queryLower, terms)
        if (sc <= 0) continue
        const red = redactSecrets(makeSnippet(text, queryLower, terms))
        redactedSecretsCount += red.redactedCount
        hits.push({
          sessionId: sid,
          title: meta.title,
          projectId: meta.projectId,
          role,
          seq: Number(r.seq ?? i),
          offset: Number(r.seq ?? i),
          source: 'opencode_db',
          score: sc,
          snippet: red.text,
        })
      }

      // Also search session titles
      for (const [sid, meta] of sessionMap.entries()) {
        const sc = scoreSnippet(`${meta.title} ${meta.directory} ${sid}`, queryLower, terms)
        if (sc > 0) {
          const red = redactSecrets(`${meta.title} (${meta.directory})`)
          redactedSecretsCount += red.redactedCount
          hits.push({
            sessionId: sid,
            title: meta.title,
            projectId: meta.projectId,
            role: 'session_meta',
            seq: 0,
            offset: 0,
            source: 'opencode_db',
            score: sc + 1,
            snippet: red.text,
          })
        }
      }
    }
  }

  // 3. Fallback search on ingested-corpus.jsonl if opencode.db absent or zero hits so far
  const corpusPath = params.corpusPath || join(resolveEvergreenDir(), 'ingested-corpus.jsonl')
  if (existsSync(corpusPath) && hits.length < limit) {
    searchedSources.push('ingested-corpus.jsonl')
    const lines = readFileSync(corpusPath, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (!ln.trim()) continue
      if (terms.length > 0 && !terms.some((t) => ln.toLowerCase().includes(t))) continue
      try {
        const rec = JSON.parse(ln)                
        if (isIsolatedSession(rec.session_id, rec.workspace)) continue
        if (params.sessionId && rec.session_id !== params.sessionId) continue
        const sc = scoreSnippet(rec.text, queryLower, terms)
        if (sc <= 0) continue
        const red = redactSecrets(makeSnippet(rec.text, queryLower, terms))
        redactedSecretsCount += red.redactedCount
        hits.push({
          sessionId: rec.session_id,
          title: rec.title || rec.session_id,
          projectId: rec.workspace || 'opencode-control-center',
          role: rec.speaker_role || 'assistant',
          seq: rec.turn_idx ?? i,
          offset: i,
          source: 'corpus',
          score: sc,
          snippet: red.text,
        })
      } catch {
        // Ignore
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.seq - b.seq)
  const seen = new Set        ()
  const deduped                     = []
  for (const h of hits) {
    const key = `${h.source}:${h.sessionId}:${h.seq}:${h.snippet.slice(0, 60)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(h)
    if (deduped.length >= limit) break
  }

  return {
    query: params.query,
    sessionId: params.sessionId,
    totalMatches: hits.length,
    searchedSources,
    redactedSecretsCount,
    results: deduped,
  }
}

                                 
                
             
              
                    
              
 

                                    
                   
                
                    
                 
                    
                   
                
               
                    
                  
                              
                        
                  
 

export function opencodeSessionRead(params   
                   
                 
                
                         
                       
 )                    {
  const offset = Math.max(0, Math.floor(params.offset ?? 0))
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 20)))

  if (isIsolatedSession(params.sessionId)) {
    return {
      sessionId: params.sessionId,
      excluded: true,
      totalRows: 0,
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      redactedSecretsCount: 0,
      rows: [],
      message: 'Session is strictly isolated (Antigravity Sync / my_obsidian_vault exclusion, Q-6).',
    }
  }

  const ysDir = resolveYesterdaySessionDir({ overrideDir: params.yesterdayDir })
  let redactedSecretsCount = 0

  if (
    ysDir &&
    (params.sessionId === 'manifest' || params.sessionId === 'yesterday_session_files_manifest') &&
    existsSync(join(ysDir, 'yesterday_session_files_manifest.json'))
  ) {
    const mf = JSON.parse(readFileSync(join(ysDir, 'yesterday_session_files_manifest.json'), 'utf8'))                           
    const byCat = (mf.by_category ?? {})                                                  
    const allItems           = []
    for (const [cat, arr] of Object.entries(byCat)) {
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        allItems.push(`[${cat}] ${String(item?.path ?? '')}${item?.mapped_windows_path ? ` -> ${String(item.mapped_windows_path)}` : ''}`)
      }
    }
    const slice = allItems.slice(offset, offset + limit).map((txt, idx) => {
      const red = redactSecrets(txt)
      redactedSecretsCount += red.redactedCount
      return { offset: offset + idx, seq: offset + idx, role: 'manifest', text: red.text }
    })
    return {
      sessionId: params.sessionId,
      title: 'yesterday_session_files_manifest.json',
      projectId: 'research-123',
      source: 'yesterday_session_files_manifest.json',
      totalRows: allItems.length,
      offset,
      limit,
      nextOffset: offset + slice.length,
      hasMore: offset + slice.length < allItems.length,
      redactedSecretsCount,
      rows: slice,
    }
  }

  // Yesterday session JSONL archive (5,341 rows)
  const isYesterday =
    params.sessionId === YESTERDAY_OPENCODE_SESSION_ID ||
    params.sessionId === 'yesterday' ||
    params.sessionId === 'yesterday_session'
  if (ysDir && isYesterday && existsSync(join(ysDir, 'yesterday_session_messages.jsonl'))) {
    const lines = readFileSync(join(ysDir, 'yesterday_session_messages.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
    const slice = lines.slice(offset, offset + limit).map((ln, idx) => {
      try {
        const row = JSON.parse(ln)                           
        const txt = extractYesterdayRowText(row) || ln
        const red = redactSecrets(txt)
        redactedSecretsCount += red.redactedCount
        return {
          offset: offset + idx,
          seq: Number(row.seq ?? offset + idx),
          role: String(row.role ?? 'assistant'),
          timestamp: typeof row.time_created === 'number' ? row.time_created : undefined,
          text: red.text,
        }
      } catch {
        const red = redactSecrets(ln)
        redactedSecretsCount += red.redactedCount
        return { offset: offset + idx, seq: offset + idx, role: 'unknown', text: red.text }
      }
    })
    return {
      sessionId: YESTERDAY_OPENCODE_SESSION_ID,
      title: 'Yesterday session stopped by network issues',
      projectId: 'research-123',
      source: 'yesterday_session_messages.jsonl',
      totalRows: lines.length,
      offset,
      limit,
      nextOffset: offset + slice.length,
      hasMore: offset + slice.length < lines.length,
      redactedSecretsCount,
      rows: slice,
    }
  }

  // OpenCode SQLite DB (all 81 non-Antigravity sessions)
  const dbPath = resolveOpencodeDbPath(params.opencodeDbPath)
  if (existsSync(dbPath)) {
    const metaRows = openSqliteQuery(dbPath, 'SELECT id, slug, directory, title FROM session_v2 WHERE id = ?', [params.sessionId])
    if (metaRows.length > 0) {
      const meta = metaRows[0]
      const dir = String(meta.directory ?? '')
      if (isIsolatedSession(params.sessionId, dir)) {
        return {
          sessionId: params.sessionId,
          excluded: true,
          totalRows: 0,
          offset,
          limit,
          nextOffset: offset,
          hasMore: false,
          redactedSecretsCount: 0,
          rows: [],
          message: 'Session directory is isolated (Antigravity / Obsidian exclusion, Q-6).',
        }
      }

      const combined                                                                 = []
      const smRows = openSqliteQuery(
        dbPath,
        'SELECT seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created ASC, seq ASC',
        [params.sessionId],
      )
      for (const r of smRows) {
        const { role, text } = extractOpenCodeBlobText(String(r.data ?? ''))
        if (!text) continue
        combined.push({ ts: Number(r.time_created ?? 0), seq: Number(r.seq ?? 0), role, text })
      }

      const legacyMsgs = openSqliteQuery(
        dbPath,
        'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
        [params.sessionId],
      )
      if (legacyMsgs.length > 0) {
        const parts = openSqliteQuery(
          dbPath,
          'SELECT message_id, data FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?) ORDER BY time_created ASC, id ASC',
          [params.sessionId],
        )
        const partsMap = new Map                  ()
        for (const p of parts) {
          const mid = String(p.message_id ?? '')
          const list = partsMap.get(mid) ?? []
          list.push(String(p.data ?? ''))
          partsMap.set(mid, list)
        }
        for (let i = 0; i < legacyMsgs.length; i++) {
          const lm = legacyMsgs[i]
          const { role, text } = extractOpenCodeBlobText(String(lm.data ?? ''), partsMap.get(String(lm.id ?? '')))
          if (!text) continue
          combined.push({ ts: Number(lm.time_created ?? 0), seq: i, role, text })
        }
      }

      const slice = combined.slice(offset, offset + limit).map((item, idx) => {
        const red = redactSecrets(item.text)
        redactedSecretsCount += red.redactedCount
        return {
          offset: offset + idx,
          seq: item.seq,
          role: item.role,
          timestamp: item.ts || undefined,
          text: red.text,
        }
      })

      return {
        sessionId: params.sessionId,
        title: String(meta.title ?? meta.slug ?? params.sessionId),
        projectId: deriveProjectIdFromDir(dir),
        source: 'opencode.db',
        totalRows: combined.length,
        offset,
        limit,
        nextOffset: offset + slice.length,
        hasMore: offset + slice.length < combined.length,
        redactedSecretsCount,
        rows: slice,
      }
    }
  }

  return {
    sessionId: params.sessionId,
    totalRows: 0,
    offset,
    limit,
    nextOffset: offset,
    hasMore: false,
    redactedSecretsCount: 0,
    rows: [],
    message: `Session "${params.sessionId}" not found in opencode.db or yesterday_session archive.`,
  }
}

export function getCorpusFileSizeBytes(corpusPath         )         {
  const p = corpusPath || join(resolveEvergreenDir(), 'ingested-corpus.jsonl')
  if (!existsSync(p)) return 0
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
