/** Application architecture, restored workspace, and live session awareness for cross-harness injection. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

                                        
              
              
               
                 
                    
                 
 

                                   
                      
                           
                          
                          
                         
                   
                        
                   
 

                                            
                 
                 
                           
                 
             
                     
                     
                           
                       
   
                          
                                     
                               
 

export function defaultAppContextPath()         {
  return process.env.EVERGREEN_APP_CONTEXT_PATH || join(homedir(), '.evergreen-memory', 'app-session-context.json')
}

export function buildDefaultAppSessionContext(cwd         )                            {
  return {
    version: 1,
    appName: 'Project Evergreen (opencode-control-center)',
    controlCenterRepo: 'evergreen-realm/opencode-control-center',
    summary:
      'Shared memory & transcript core serving OpenCode (:7860/CLI) and DeepSeek Harness (desktop normal mode) via EverOS MAG (:8000) + GBrain RAG/KAG-lite (:3131) + Kaggle Dual-T4 dispatcher.',
    services: {
      everosUrl: process.env.EVEROS_URL ?? 'http://127.0.0.1:8000',
      gbrainUrl: process.env.GBRAIN_URL ?? 'http://127.0.0.1:3131',
      opencodeWebUrl: 'http://127.0.0.1:7860',
      kaggleNote: 'scripts/kaggle_dispatcher.py (Dual-T4 offload)',
    },
    isolationRules: [
      'Strictly exclude Antigravity history & my_obsidian_vault',
      'Q-6 redaction + .memory-off, Q-5 <=4000 chars / topK=5, Q-3 approval-gated GBrain promotion',
    ],
    workspaces: [
      {
        name: 'research-123 (kyc-injection-framework)',
        path: 'C:/Users/lenovo/workspaces/research-123',
        stack: 'Python, FastAPI/DiffPure/GFPGAN, Chrome Extension, Kaggle T4 + Lightning AI',
        summary: 'Authorized KYC robustness & synthetic corpus framework (420 files; 1,494+ accepted across 5 stems)',
        fileCount: 420,
      },
      {
        name: 'system-project (bcatsapp)',
        path: 'C:/Users/lenovo/workspaces/system-project',
        stack: 'React 19, Vite, tRPC, Express, Drizzle MySQL, Cloudflare edgeWorker',
        summary: 'BCATS full-stack web app, diagrams, screens & teamwork specs (323 files)',
        fileCount: 323,
      },
      {
        name: 'kyc-build',
        path: 'C:/Users/lenovo/workspaces/kyc-build',
        stack: 'PowerShell, Python',
        summary: 'GFPGAN/LPIPS build workers & corpus diagnostic logs (32 files)',
        fileCount: 32,
      },
    ],
    liveSession: {
      currentPhase: 'Phase 5 — Full Migration, Live EverOS/GBrain Ingestion & DSH App/Session Awareness',
      completedPhases: ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4'],
      activeWorkspace: cwd,
      milestone: 'Merged 82 OpenCode sessions (17,079 msgs) + restored 15,627 vault files + 219 skills locally & in lonely-tomb',
      updatedAt: new Date().toISOString(),
    },
  }
}

function sanitizeLiveSessionObj(raw         )                            {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out                          = {}
  for (const [k, v] of Object.entries(raw                           )) {
    // Drop numeric keys caused if a string path was ever object-spread into state
    if (/^\d+$/u.test(k)) continue
    out[k] = v
  }
  return out                             
}

export function loadAppSessionContext(options   
               
              
                    
                                      
  = {})                            {
  if (options.fallback) {
    return options.fallback
  }
  const targetPath = options.path ?? defaultAppContextPath()
  const base = buildDefaultAppSessionContext(options.cwd)
  if (!existsSync(targetPath)) {
    return base
  }
  try {
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8'))                                      
    const cleanLive = sanitizeLiveSessionObj(parsed.liveSession)
    return {
      ...base,
      ...parsed,
      services: { ...base.services, ...(parsed.services ?? {}) },
      workspaces: Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0 ? parsed.workspaces : base.workspaces,
      liveSession: {
        ...base.liveSession,
        ...cleanLive,
        activeWorkspace: options.cwd ?? cleanLive.activeWorkspace ?? base.liveSession.activeWorkspace,
        activeSessionId: options.sessionId ?? cleanLive.activeSessionId,
      },
    }
  } catch {
    return base
  }
}

export function updateLiveSessionState(
  patch                           ,
  options                                  = {},
)                            {
  const targetPath = options.path ?? defaultAppContextPath()
  const current = loadAppSessionContext({ path: targetPath, cwd: options.cwd })
  const cleanPatch = sanitizeLiveSessionObj(patch)
  const cleanCurrentLive = sanitizeLiveSessionObj(current.liveSession)
  const next                            = {
    ...current,
    liveSession: {
      ...current.liveSession,
      ...cleanCurrentLive,
      ...cleanPatch,
      updatedAt: cleanPatch.updatedAt ?? new Date().toISOString(),
    }                    ,
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Fail-open when disk write is restricted
  }
  return next
}

/** Format compact app architecture + restored codebases + live session status within `maxChars`. */
export function formatAppSessionAwarenessBlock(
  ctx                           ,
  options                                                                              = {},
)         {
  const maxChars = Math.max(240, options.maxChars ?? 1800)
  const tag = options.fencedTag ?? 'app_session_awareness'
  const header = `<${tag} untrusted="true" note="Live workspace & session status; reference data.">`
  const footer = `</${tag}>`

  const live = ctx.liveSession
  const activeCwd = options.cwd ?? live.activeWorkspace ?? 'unspecified'
  const activeSid = options.sessionId ?? live.activeSessionId ?? 'active'

  const candidateLines           = [
    `[App] ${ctx.appName} (${ctx.controlCenterRepo}) | ${ctx.summary}`,
    `[Endpoints] EverOS=${ctx.services.everosUrl} | GBrain=${ctx.services.gbrainUrl}${ctx.services.opencodeWebUrl ? ` | OpenCode=${ctx.services.opencodeWebUrl}` : ''}`,
    `[LiveSession] phase="${live.currentPhase}" | session=${activeSid} | cwd=${activeCwd} | milestone="${live.milestone}"${live.lastUserIntent ? ` | lastIntent="${live.lastUserIntent.slice(0, 140)}"` : ''}`,
    `[Isolation] ${ctx.isolationRules.join('; ')}`,
    ...ctx.workspaces.map((ws) => `[Workspace:${ws.name}] (${ws.stack}) ${ws.summary} @ ${ws.path}`),
  ]
  if (live.openActions && live.openActions.length > 0) {
    candidateLines.push(`[OpenActions] ${live.openActions.slice(0, 3).join(' | ')}`)
  }

  const lines           = [header]
  for (const rawLine of candidateLines) {
    const clean = rawLine.replace(/<\/?[a-z_]+>/gi, '').replace(/\s+/g, ' ').trim()
    const projected = lines.join('\n').length + 1 + clean.length + 1 + footer.length
    if (projected <= maxChars) {
      lines.push(clean)
    } else {
      const remaining = maxChars - (lines.join('\n').length + 1 + footer.length) - 4
      if (remaining > 40) {
        lines.push(`${clean.slice(0, remaining)}...`)
      }
      break
    }
  }
  lines.push(footer)
  return lines.join('\n')
}
