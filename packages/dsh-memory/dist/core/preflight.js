/** Startup Preload & Embedding Readiness Preflight (`runStartupPreflight`) for DSH (Phase D). */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getCorpusFileSizeBytes,
  inspectYesterdaySession,
  loadCorpusDocuments,
  resolveEvergreenDir,
} from './corpus-bridge.js'
                                                      
                                                         
import { HybridRetrievalIndex } from './retrieval.js'
import { defaultAppContextPath, loadAppSessionContext,                                } from './workspace-context.js'

                                         
                              
                   
           
                
                    
                        
                           
                            
                     
                  
   
           
                
                    
                       
                      
                  
   
               
                
                   
                       
                          
                              
                             
                               
                                
                         
                              
   
                     
                  
                
                           
                            
                               
                                 
   
               
                      
                       
                       
                            
                      
                             
   
               
                
                   
                          
                            
                         
   
                            
                          
                      
                           
                                          
                                        
                               
   
                    
 

export function appendPluginLog(logPath        , event        , details                          )       {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(details ?? {}),
    })
    appendFileSync(logPath, `${line}\n`, 'utf8')
  } catch {
    // Non-fatal logging failure
  }
}

                                    

let lastAutoHealTriggerMs = 0

export function resetAutoHealCooldownForTest()       {
  lastAutoHealTriggerMs = 0
}

export function resolveEnsureStackScriptPath(overridePath         )                     {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    overridePath,
    process.env.EVERGREEN_ENSURE_STACK_SCRIPT,
    resolve(here, '..', '..', '..', 'scripts', 'ensure_stack.py'),
    resolve(here, '..', '..', '..', '..', 'scripts', 'ensure_stack.py'),
    join(homedir(), '.gemini', 'antigravity', 'scratch', 'opencode-control-center', 'scripts', 'ensure_stack.py'),
  ].filter((x)              => Boolean(x))
  for (const cand of candidates) {
    if (existsSync(cand)) return cand
  }
  return undefined
}

function isLocalEndpointUrl(url         )          {
  if (!url) return false
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url.trim())
}

export function triggerEnsureStackDetached(options    
                 
                       
                        
                                
                     
                    
                     
 )                                                              {
  const cooldownMs = options?.cooldownMs ?? 60_000
  const now = Date.now()
  if (now - lastAutoHealTriggerMs < cooldownMs) {
    return { triggered: false, reason: 'cooldown_active' }
  }

  const baseDir = resolveEvergreenDir(options?.evergreenDir)
  const lockPath = join(baseDir, 'ensure-stack.lock')
  if (existsSync(lockPath)) {
    try {
      const ageMs = now - statSync(lockPath).mtimeMs
      if (ageMs >= 0 && ageMs < 120_000) {
        return { triggered: false, reason: 'lockfile_active' }
      }
    } catch {
      // ignore stat race
    }
  }

  const scriptPath = resolveEnsureStackScriptPath(options?.ensureStackScriptPath)
  if (!scriptPath) {
    return { triggered: false, reason: 'script_not_found' }
  }

  lastAutoHealTriggerMs = now
  const args = [scriptPath, '--ensure']
  if (options?.noIngest) args.push('--no-ingest')
  const spawnImpl = options?.spawnFn ?? spawn
  try {
    const child = spawnImpl(process.env.PYTHON || 'python', args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    child?.unref?.()
    const logPath = options?.pluginLogPath || join(baseDir, 'dsh-plugin.log')
    appendPluginLog(logPath, 'auto_heal_triggered', {
      reason: options?.reason ?? 'endpoint_unreachable',
      scriptPath,
    })
    return { triggered: true, reason: options?.reason ?? 'endpoint_unreachable', scriptPath }
  } catch (err) {
    return {
      triggered: false,
      reason: `spawn_error:${err instanceof Error ? err.message : String(err)}`,
      scriptPath,
    }
  }
}

                                          
                       
                          
                    
                    
                       
                         
                         
                     
                              
                        
                       
                  
                     
                        
                         
                     
                    
                                
                     
 

                                         
                                
                                  
                                       
 

export async function runStartupPreflight(options                          = {})                                  {
  const t0 = performance.now()
  const baseDir = resolveEvergreenDir(options.evergreenDir)
  const appContextPath = options.appContextPath || defaultAppContextPath()
  const checkpointPath = options.checkpointPath || join(baseDir, 'ingest-checkpoint.json')
  const corpusPath = options.corpusPath || join(baseDir, 'ingested-corpus.jsonl')
  const preflightOutputPath = options.preflightOutputPath || join(baseDir, 'startup-preflight.json')
  const pluginLogPath = options.pluginLogPath || join(baseDir, 'dsh-plugin.log')
  const warnings           = []

  // 1 & 2. Check EverOS (:8000) and GBrain (:3131) in parallel
  const everosStatus                                   = {
    url: options.everosUrl,
    healthy: false,
    episodeCount: 0,
    atomicFactCount: 0,
    userProfileCount: 0,
    nonEmpty: false,
  }
  const gbrainStatus                                   = {
    url: options.gbrainUrl,
    healthy: false,
    queryReady: false,
    hitsSample: 0,
  }

  await Promise.all([
    (async () => {
      if (!options.everos) return
      try {
        const h = await options.everos.health(5000)
        everosStatus.healthy = h.status === 'ok'
        const raw = (h.raw ?? {})                           
        const cascade = (raw.cascade ?? {})                           
        const indexRows = (cascade.index_rows ?? raw.index_rows ?? {})                           
        everosStatus.episodeCount = Number(indexRows.episode ?? 0)
        everosStatus.atomicFactCount = Number(indexRows.atomic_fact ?? 0)
        everosStatus.userProfileCount = Number(indexRows.user_profile ?? 0)
        everosStatus.nonEmpty = everosStatus.episodeCount + everosStatus.atomicFactCount > 0
        if (!everosStatus.nonEmpty) {
          warnings.push('EverOS /health reports 0 indexed episodes/atomic_facts; semantic recall will rely on GBrain + local HybridRetrievalIndex.')
        }
      } catch (err) {
        everosStatus.error = err instanceof Error ? err.message : String(err)
        warnings.push(`EverOS health check unreachable: ${everosStatus.error}`)
      }
    })(),
    (async () => {
      if (!options.gbrain) return
      try {
        const gh = await options.gbrain.health(5000)
        gbrainStatus.healthy = gh.status === 'ok'
        const hits = await options.gbrain.query('research-123 yesterday_session', 3, 5000)
        gbrainStatus.queryReady = true
        gbrainStatus.hitsSample = hits.length
      } catch (err) {
        gbrainStatus.error = err instanceof Error ? err.message : String(err)
        warnings.push(`GBrain readiness check issue: ${gbrainStatus.error}`)
      }
    })(),
  ])

  // Trigger non-blocking self-heal when local EverOS or GBrain is unreachable
  if (
    options.autoHeal !== false &&
    ((options.everos && !everosStatus.healthy && isLocalEndpointUrl(options.everosUrl)) ||
      (options.gbrain && !gbrainStatus.healthy && isLocalEndpointUrl(options.gbrainUrl)))
  ) {
    triggerEnsureStackDetached({
      reason: `preflight_unhealthy(everos=${everosStatus.healthy},gbrain=${gbrainStatus.healthy})`,
      evergreenDir: baseDir,
      pluginLogPath,
      ensureStackScriptPath: options.ensureStackScriptPath,
      spawnFn: options.spawnFn,
    })
  }

  // 3. Check ingest-checkpoint.json completeness
  const cpStatus                                       = {
    path: checkpointPath,
    exists: existsSync(checkpointPath),
    hasSummary: false,
    opencodeTarget: 0,
    opencodeIngestedOk: 0,
    opencodeFlushedOk: 0,
    dshAudit8a1d60a0Ok: false,
    yesterdayManifestOk: false,
    gbrainPagesOk: 0,
    localCorpusRecords: 0,
  }
  if (cpStatus.exists) {
    try {
      const cp = JSON.parse(readFileSync(checkpointPath, 'utf8'))                           
      const sum = (cp.summary ?? {})                           
      cpStatus.hasSummary = typeof cp.summary === 'object' && cp.summary !== null
      cpStatus.opencodeTarget = Number(sum.opencode_target ?? Object.keys((cp.sessions          ) ?? {}).length)
      cpStatus.opencodeIngestedOk = Number(sum.opencode_ingested_ok ?? 0)
      cpStatus.opencodeFlushedOk = Number(sum.opencode_flushed_ok ?? 0)
      cpStatus.dshAudit8a1d60a0Ok = Boolean(sum.dsh_audit_8a1d60a0_ok)
      cpStatus.yesterdayManifestOk = Boolean(sum.yesterday_manifest_ok)
      cpStatus.gbrainPagesOk = Number(sum.gbrain_pages_ok ?? Object.keys((cp.gbrain_pages          ) ?? {}).length)
      cpStatus.localCorpusRecords = Number(sum.local_corpus_records ?? 0)
      if (!cpStatus.hasSummary || cpStatus.opencodeFlushedOk < cpStatus.opencodeTarget) {
        warnings.push(
          `ingest-checkpoint summary incomplete or partial flush (ingested_ok=${cpStatus.opencodeIngestedOk}, flushed_ok=${cpStatus.opencodeFlushedOk}/${cpStatus.opencodeTarget}).`,
        )
      }
    } catch (err) {
      warnings.push(`Failed reading ingest-checkpoint.json: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    warnings.push(`ingest-checkpoint.json missing at ${checkpointPath}`)
  }

  // 4. Inspect yesterday_session (5,341 rows + manifest + workspace.json)
  const ys = inspectYesterdaySession({
    overrideDir: options.yesterdayDir,
    dshHome: options.dshHome,
    researchWs: options.researchWs,
  })
  if (!ys.found) {
    warnings.push('yesterday_session archive not found on disk.')
  }

  // 5. Load app-session-context.json + pre-warm HybridRetrievalIndex (192-d vectors + BM25)
  const indexT0 = performance.now()
  const appContext = loadAppSessionContext({ path: appContextPath })
  const { docs } = loadCorpusDocuments({
    corpusPath,
    yesterdayDir: ys.dir,
    maxDocs: options.maxCorpusDocs ?? 3000,
  })

  // Also inject workspace awareness docs into local index for instant cold-start workspace resolution
  for (const ws of appContext.workspaces) {
    docs.push({
      id: `workspace:${ws.name}`,
      title: `Workspace ${ws.name}`,
      text: `${ws.name} at ${ws.path}: ${ws.stack}. ${ws.summary} (${ws.fileCount ?? 0} files).`,
      project_id: ws.name.split(/\s+/)[0],
      owner_type: 'agent',
      source_tier: 1,
      tags: ['workspace_context', ws.path],
    })
  }
  if (appContext.liveSession?.milestone) {
    docs.push({
      id: 'app-context:live-session',
      title: `${appContext.appName} Live Session Milestone`,
      text: `${appContext.appName} phase=${appContext.liveSession.currentPhase} activeWorkspace=${appContext.liveSession.activeWorkspace}: ${appContext.liveSession.milestone}`,
      project_id: 'opencode-control-center',
      owner_type: 'agent',
      source_tier: 1,
      tags: ['app_session_context'],
    })
  }

  const localIndex = new HybridRetrievalIndex(docs)
  const preloadDurationMs = Number((performance.now() - indexT0).toFixed(2))
  const corpusBytes = getCorpusFileSizeBytes(corpusPath)

  const maxRecallChars = options.recallMaxChars ?? 4000
  const recallTopK = options.recallTopK ?? 5
  const estimatedBaselineTokensPerTurn = 2375
  const estimatedRecallTokensPerTurn = Math.ceil(Math.min(maxRecallChars, 1400) / 4)
  const estimatedSavingsPct = Number(
    (((estimatedBaselineTokensPerTurn - estimatedRecallTokensPerTurn) / estimatedBaselineTokensPerTurn) * 100).toFixed(1),
  )

  const indexedDocsCount = localIndex.size()
  const hasSemanticPath = indexedDocsCount > 0 || everosStatus.healthy || gbrainStatus.healthy
  const report                         = {
    status: hasSemanticPath ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    everos: everosStatus,
    gbrain: gbrainStatus,
    checkpoint: cpStatus,
    yesterdaySession: {
      found: ys.found,
      dir: ys.dir,
      messageRowCount: ys.messageRowCount,
      manifestPresent: ys.manifestPresent,
      manifestUniquePaths: ys.manifestUniquePaths,
      workspaceSessionCount: ys.workspaceSessionCount,
    },
    localIndex: {
      corpusPath,
      corpusBytes,
      indexedDocs: indexedDocsCount,
      vectorDimensions: 192,
      bm25Ready: indexedDocsCount > 0,
      preloadDurationMs,
    },
    appContext: {
      path: appContextPath,
      loaded: existsSync(appContextPath),
      workspaceCount: appContext.workspaces.length,
      activeWorkspace: appContext.liveSession?.activeWorkspace,
      currentPhase: appContext.liveSession?.currentPhase,
    },
    tokenEfficiencyEstimate: {
      maxRecallChars,
      recallTopK,
      ttlCacheMinutes: 15,
      estimatedBaselineTokensPerTurn,
      estimatedRecallTokensPerTurn,
      estimatedSavingsPct,
    },
    warnings,
  }

  try {
    mkdirSync(dirname(preflightOutputPath), { recursive: true })
    writeFileSync(preflightOutputPath, JSON.stringify(report, null, 2), 'utf8')
  } catch {
    // Non-fatal
  }

  appendPluginLog(pluginLogPath, 'startup_preflight', {
    status: report.status,
    everosHealthy: everosStatus.healthy,
    everosEpisodes: everosStatus.episodeCount,
    gbrainHealthy: gbrainStatus.healthy,
    gbrainQueryReady: gbrainStatus.queryReady,
    indexedDocs: indexedDocsCount,
    yesterdayRows: ys.messageRowCount,
    workspaceSessions: ys.workspaceSessionCount,
    preloadMs: preloadDurationMs,
    estimatedTokenSavingsPct: estimatedSavingsPct,
    warningsCount: warnings.length,
  })

  return { report, localIndex, appContext }
}
