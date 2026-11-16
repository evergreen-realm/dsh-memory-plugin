/** Lonely-Tomb Codespace & HuggingFace Cloud Vault Bridges with Q-6 Secret Redaction (Phase D). */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { triggerEnsureStackDetached } from './preflight.js'
import { redactSecrets } from './redactor.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_CODESPACE_NAME = 'lonely-tomb-vpv6pjr956wqc6ggw'
export const DEFAULT_HF_VAULT_REPO = 'evergreen-rara/opencode-cloud-vault'

                             
                
                
                  
 

                                
              
                 
                                                                             
                        

export function buildUtf8SubprocessEnv(extra                                     )                    {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...(extra ?? {}),
  }
}

export const defaultSubprocessRunner                   = async (cmd, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 20000,
      maxBuffer: 4 * 1024 * 1024,
      env: buildUtf8SubprocessEnv(options?.env),
      windowsHide: true,
    })
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 }
  } catch (err) {
    const e = err                                                                         
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr || e.message || String(err),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

function sanitizeOutput(text        )                                          {
  return redactSecrets(text)
}

function isSensitiveSecretPath(filePath        )          {
  const low = basename(filePath).toLowerCase()
  return (
    low === '.env' ||
    low.startsWith('.env.') ||
    low.includes('credentials') ||
    low.includes('gbrain-creds') ||
    low.endsWith('.pem') ||
    low.endsWith('.key')
  )
}

                                        
                   
                        
              
                                                         
                                                         
                                                           
   
                              
              
 

async function probeEndpoint(url        , fetchFn              , timeoutMs = 5000)                                            {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false }
  }
}

export async function codespaceStatus(options    
                    
                    
                    
                      
                           
                        
 )                                 {
  const codespace = options?.codespace || process.env.EVERGREEN_CODESPACE || DEFAULT_CODESPACE_NAME
  const runner = options?.runner ?? defaultSubprocessRunner
  const fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis)
  const everosUrl = (options?.everosUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '')
  const gbrainUrl = (options?.gbrainUrl || 'http://127.0.0.1:3131').replace(/\/+$/, '')
  const opencodeUrl = (options?.opencodeUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '')

  const [ghRes, everos, gbrain, opencode] = await Promise.all([
    runner('gh', ['codespace', 'view', '-c', codespace, '--json', 'name,state,displayName,repository'], { timeoutMs: 12000 }),
    probeEndpoint(`${everosUrl}/health`, fetchFn),
    probeEndpoint(`${gbrainUrl}/health`, fetchFn),
    probeEndpoint(`${opencodeUrl}/project`, fetchFn),
  ])

  let state = 'unknown'
  const red = sanitizeOutput(ghRes.stdout || ghRes.stderr)
  if (ghRes.exitCode === 0 && ghRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(ghRes.stdout)                      
      state = parsed.state ?? 'Available'
    } catch {
      state = 'reachable'
    }
  } else if (everos.ok || gbrain.ok || opencode.ok) {
    state = 'tunnel-active'
  } else {
    state = `error:${ghRes.exitCode}`
  }

  // Non-blocking auto-heal when any local tunnel endpoint is down in live mode
  if (!options?.fetchFn && !options?.runner && (!everos.ok || !gbrain.ok || !opencode.ok)) {
    triggerEnsureStackDetached({
      reason: `codespace_status_down(everos=${everos.ok},gbrain=${gbrain.ok},opencode=${opencode.ok})`,
    })
  }

  return {
    codespace,
    codespaceState: state,
    endpoints: {
      everos: { url: everosUrl, ...everos },
      gbrain: { url: gbrainUrl, ...gbrain },
      opencode: { url: opencodeUrl, ...opencode },
    },
    redactedSecretsCount: red.redactedCount,
    raw: red.text.slice(0, 1200),
  }
}

                                      
                   
                  
                
                
                              
 

export async function codespaceExec(params   
             
                    
                    
                           
 )                               {
  const codespace = params.codespace || process.env.EVERGREEN_CODESPACE || DEFAULT_CODESPACE_NAME
  const runner = params.runner ?? defaultSubprocessRunner
  const res = await runner('gh', ['codespace', 'ssh', '-c', codespace, '--', 'bash', '-lc', params.cmd], {
    timeoutMs: params.timeoutMs ?? 25000,
  })
  const out = sanitizeOutput(res.stdout)
  const err = sanitizeOutput(res.stderr)
  return {
    codespace,
    exitCode: res.exitCode,
    stdout: out.text.slice(0, 16000),
    stderr: err.text.slice(0, 4000),
    redactedSecretsCount: out.redactedCount + err.redactedCount,
  }
}

                                      
                   
                          
                
                     
                  
                
                              
 

export async function codespaceSync(params   
                                                                    
              
                     
                    
                    
                           
 )                               {
  const codespace = params.codespace || process.env.EVERGREEN_CODESPACE || DEFAULT_CODESPACE_NAME
  const runner = params.runner ?? defaultSubprocessRunner
  const normDir                =
    params.direction === 'up' || params.direction === 'push' || params.direction === 'upload' ? 'up' : 'down'

  if (normDir === 'up' && isSensitiveSecretPath(params.path)) {
    return {
      codespace,
      direction: normDir,
      source: params.path,
      destination: params.remotePath || params.path,
      exitCode: 1,
      output: 'Blocked upload of sensitive credential/secret file (Q-6).',
      redactedSecretsCount: 0,
    }
  }

  const remoteTarget = params.remotePath || `/workspaces/opencode-control-center/${basename(params.path)}`
  const args = ['codespace', 'cp', '-c', codespace]
  if (normDir === 'up' && existsSync(params.path) && statSync(params.path).isDirectory()) {
    args.push('-r')
  }
  const source = normDir === 'up' ? params.path : `remote:${params.path}`
  const destination = normDir === 'up' ? `remote:${remoteTarget}` : params.remotePath || join(process.cwd(), basename(params.path))
  args.push(source, destination)

  const res = await runner('gh', args, { timeoutMs: params.timeoutMs ?? 45000 })
  const combined = sanitizeOutput(`${res.stdout}\n${res.stderr}`.trim())
  return {
    codespace,
    direction: normDir,
    source,
    destination,
    exitCode: res.exitCode,
    output: combined.text.slice(0, 8000),
    redactedSecretsCount: combined.redactedCount,
  }
}

                                    
                
                 
                    
                 
                              
                
 

function buildHfPythonHeader()         {
  return [
    'import json, os, sys',
    'if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
    'if hasattr(sys.stderr, "reconfigure"): sys.stderr.reconfigure(encoding="utf-8", errors="replace")',
  ].join('\n')
}

let cachedHfToken                    

function readTokenFromEnvFile(filePath        )         {
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const match = /^(?:export\s+)?(HF_TOKEN|HUGGINGFACE_HUB_TOKEN)\s*=\s*(.+)$/.exec(line)
      if (!match) continue
      let val = match[2] .trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      } else {
        // Strip unquoted trailing inline comment if present
        const hashIdx = val.indexOf(' #')
        if (hashIdx >= 0) val = val.slice(0, hashIdx).trim()
      }
      if (val) return val
    }
  } catch {
    // Non-fatal
  }
  return ''
}

function defaultEnvCandidatePaths()           {
  const home = homedir()
  const here = dirname(fileURLToPath(import.meta.url))
  // Works both from packages/memory-core/src and dist/core
  const candidates = [
    join(home, '.evergreen-memory', '.env'),
    resolve(here, '..', '..', '..', '.env'),
    resolve(here, '..', '..', '..', 'scripts', '.env'),
    resolve(here, '..', '..', '..', '..', '.env'),
    resolve(here, '..', '..', '..', '..', 'scripts', '.env'),
    join(home, 'workspaces', 'research-123', 'part-3-codebase', 'kyc-injection-framework', '.env'),
    join(process.cwd(), '.env'),
  ]
  return [...new Set(candidates)]
}

/**
 * Collect HF_TOKEN candidates in priority order without caching unvalidated tokens:
 * 1) explicit env vars (HF_TOKEN / HUGGINGFACE_HUB_TOKEN)
 * 2) ~/.cache/huggingface/token & ~/.huggingface/token
 * 3) local workspace / vault .env files (e.g., kyc-injection-framework/.env, ~/.evergreen-memory/.env)
 * 4) lonely-tomb Codespace user-secrets-envs.json (note: Codespace shared secret may be stale/revoked)
 */
async function collectHfTokenCandidates(runner                  , envPaths                    )                    {
  const seen = new Set        ()
  const out           = []
  const push = (t                    ) => {
    const clean = (t ?? '').trim()
    if (clean && !seen.has(clean)) {
      seen.add(clean)
      out.push(clean)
    }
  }

  push(process.env.HF_TOKEN)
  push(process.env.HUGGINGFACE_HUB_TOKEN)

  for (const tokFile of [
    join(homedir(), '.cache', 'huggingface', 'token'),
    join(homedir(), '.huggingface', 'token'),
  ]) {
    if (existsSync(tokFile)) {
      try {
        push(readFileSync(tokFile, 'utf8'))
      } catch {
        // ignore
      }
    }
  }

  for (const envPath of envPaths ?? defaultEnvCandidatePaths()) {
    push(readTokenFromEnvFile(envPath))
  }

  const codespace = process.env.EVERGREEN_CODESPACE || DEFAULT_CODESPACE_NAME
  const pyCmd =
    "python3 -c \"import json,os; d=json.load(open('/workspaces/.codespaces/shared/user-secrets-envs.json')); print(d.get('HF_TOKEN') or os.environ.get('HF_TOKEN',''))\""
  const res = await runner('gh', ['codespace', 'ssh', '-c', codespace, '--', pyCmd], { timeoutMs: 12000 })
  if (res.exitCode === 0) {
    push(res.stdout.trim().split(/\r?\n/)[0])
  }

  return out
}

async function fetchHfWithAuth(
  url        ,
  options   
                            
                         
                      
                                
   ,
)                                                                   {
  const tried = new Set        ()
  const tryToken = async (tok        )                    =>
    options.fetchFn(url, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    })

  // 1. Try previously validated cached token first; invalidate immediately on 401/403.
  if (cachedHfToken) {
    tried.add(cachedHfToken)
    const resp = await tryToken(cachedHfToken)
    if (resp.status !== 401 && resp.status !== 403) {
      return { response: resp, token: cachedHfToken }
    }
    cachedHfToken = undefined
  }

  // 2. Iterate through candidates; only cache a token that succeeds (< 400).
  const candidates = await collectHfTokenCandidates(options.runner, options.envPaths)
  let lastResp                      
  for (const tok of candidates) {
    if (tried.has(tok)) continue
    tried.add(tok)
    const resp = await tryToken(tok)
    if (resp.status !== 401 && resp.status !== 403) {
      if (resp.ok) cachedHfToken = tok
      return { response: resp, token: tok }
    }
    lastResp = resp
  }

  // 3. Last resort: unauthenticated request if no token worked
  if (!lastResp) {
    const resp = await tryToken('')
    return { response: resp, token: '' }
  }
  return { response: lastResp }
}

export function clearCachedHfTokenForTest()       {
  cachedHfToken = undefined
}

export async function hfVaultList(params    
                 
                 
                
                           
                        
                              
 )                             {
  const repoId = params?.repoId || process.env.EVERGREEN_HF_VAULT_REPO || DEFAULT_HF_VAULT_REPO
  const limit = Math.max(1, Math.min(200, params?.limit ?? 50))
  const prefix = params?.prefix ?? ''
  const customRunner = params?.runner
  const runner = customRunner ?? defaultSubprocessRunner
  const fetchFn = params?.fetchFn ?? globalThis.fetch.bind(globalThis)

  // If caller did not inject a mocked subprocess runner (or injected fetchFn directly), use HuggingFace Hub REST API with candidate validation.
  if (!customRunner || params?.fetchFn) {
    try {
      const apiUrl = `https://huggingface.co/api/datasets/${repoId}/tree/main?recursive=true`
      const { response: resp } = await fetchHfWithAuth(apiUrl, {
        runner,
        fetchFn,
        timeoutMs: 15000,
        envPaths: params?.envPaths,
      })
      if (!resp || !resp.ok) {
        const status = resp?.status ?? 0
        const errText = resp ? await resp.text().catch(() => resp.statusText) : 'No response'
        const redErr = sanitizeOutput(`HF API HTTP ${status}: ${errText}`)
        return { repoId, prefix: prefix || undefined, totalFiles: 0, files: [], redactedSecretsCount: redErr.redactedCount, error: redErr.text }
      }
      const items = (await resp.json())                                           
      let redactedSecretsCount = 0
      const matched = items
        .filter((it) => it.type === 'file' && typeof it.path === 'string' && (!prefix || it.path.startsWith(prefix)))
        .map((it) => {
          const r = sanitizeOutput(it.path )
          redactedSecretsCount += r.redactedCount
          return r.text
        })
      return {
        repoId,
        prefix: prefix || undefined,
        totalFiles: matched.length,
        files: matched.slice(0, limit),
        redactedSecretsCount,
      }
    } catch (err) {
      const redErr = sanitizeOutput(err instanceof Error ? err.message : String(err))
      return { repoId, prefix: prefix || undefined, totalFiles: 0, files: [], redactedSecretsCount: redErr.redactedCount, error: redErr.text }
    }
  }

  const script = [
    buildHfPythonHeader(),
    'from huggingface_hub import HfApi',
    'api = HfApi()',
    'files = api.list_repo_files(repo_id=sys.argv[1], repo_type="dataset")',
    'pref = sys.argv[2]',
    'lim = int(sys.argv[3])',
    'matched = [f for f in files if (not pref or f.startswith(pref))]',
    'print(json.dumps({"total": len(matched), "files": matched[:lim]}, ensure_ascii=False))',
  ].join('\n')

  const res = await runner('python', ['-c', script, repoId, prefix, String(limit)], { timeoutMs: 25000 })
  if (res.exitCode !== 0) {
    const err = sanitizeOutput(res.stderr || res.stdout)
    return { repoId, prefix: prefix || undefined, totalFiles: 0, files: [], redactedSecretsCount: err.redactedCount, error: err.text }
  }
  try {
    const parsed = JSON.parse(res.stdout)                                        
    let redactedSecretsCount = 0
    const files = (parsed.files ?? []).map((f) => {
      const r = sanitizeOutput(f)
      redactedSecretsCount += r.redactedCount
      return r.text
    })
    return {
      repoId,
      prefix: prefix || undefined,
      totalFiles: Number(parsed.total ?? files.length),
      files,
      redactedSecretsCount,
    }
  } catch {
    const out = sanitizeOutput(res.stdout)
    return { repoId, prefix: prefix || undefined, totalFiles: 0, files: [], redactedSecretsCount: out.redactedCount, error: out.text }
  }
}

export async function hfVaultDownload(params   
                  
                   
                 
                           
                        
 )                                                                                                                               {
  const repoId = params.repoId || process.env.EVERGREEN_HF_VAULT_REPO || DEFAULT_HF_VAULT_REPO
  const localDir = params.localDir || join(process.cwd(), 'downloads')
  const customRunner = params.runner
  const runner = customRunner ?? defaultSubprocessRunner
  const fetchFn = params.fetchFn ?? globalThis.fetch.bind(globalThis)

  if (!customRunner || params.fetchFn) {
    try {
      const rel = params.filename.replace(/^\/+/, '')
      const dlUrl = `https://huggingface.co/datasets/${repoId}/resolve/main/${encodeURI(rel)}`
      const { response: resp } = await fetchHfWithAuth(dlUrl, { runner, fetchFn, timeoutMs: 45000 })
      if (!resp || !resp.ok) {
        const err = sanitizeOutput(`HF download HTTP ${resp?.status ?? 0}: ${resp?.statusText ?? 'No response'}`)
        return { repoId, filename: params.filename, ok: false, error: err.text, redactedSecretsCount: err.redactedCount }
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      const destPath = join(localDir, rel)
      mkdirSync(dirname(destPath), { recursive: true })
      writeFileSync(destPath, buf)
      const red = sanitizeOutput(destPath)
      return { repoId, filename: params.filename, localPath: red.text, ok: true, redactedSecretsCount: red.redactedCount }
    } catch (err) {
      const red = sanitizeOutput(err instanceof Error ? err.message : String(err))
      return { repoId, filename: params.filename, ok: false, error: red.text, redactedSecretsCount: red.redactedCount }
    }
  }

  const script = [
    buildHfPythonHeader(),
    'from huggingface_hub import hf_hub_download',
    'p = hf_hub_download(repo_id=sys.argv[1], filename=sys.argv[2], repo_type="dataset", local_dir=sys.argv[3])',
    'print(json.dumps({"local_path": p}, ensure_ascii=False))',
  ].join('\n')

  const res = await runner('python', ['-c', script, repoId, params.filename, localDir], { timeoutMs: 60000 })
  if (res.exitCode !== 0) {
    const err = sanitizeOutput(res.stderr || res.stdout)
    return { repoId, filename: params.filename, ok: false, error: err.text, redactedSecretsCount: err.redactedCount }
  }
  try {
    const parsed = JSON.parse(res.stdout)                           
    const red = sanitizeOutput(parsed.local_path ?? '')
    return { repoId, filename: params.filename, localPath: red.text, ok: true, redactedSecretsCount: red.redactedCount }
  } catch {
    const red = sanitizeOutput(res.stdout)
    return { repoId, filename: params.filename, localPath: red.text.trim(), ok: true, redactedSecretsCount: red.redactedCount }
  }
}

export async function hfVaultUpload(params   
                   
                     
                 
                           
 )                                                                                                                           {
  const repoId = params.repoId || process.env.EVERGREEN_HF_VAULT_REPO || DEFAULT_HF_VAULT_REPO
  const pathInRepo = params.pathInRepo || basename(params.localPath)
  const runner = params.runner ?? defaultSubprocessRunner

  if (isSensitiveSecretPath(params.localPath) || isSensitiveSecretPath(pathInRepo)) {
    return {
      repoId,
      pathInRepo,
      ok: false,
      error: 'Blocked upload of sensitive credential file to HF vault (Q-6 fail-closed).',
      redactedSecretsCount: 0,
    }
  }
  if (!existsSync(params.localPath)) {
    return { repoId, pathInRepo, ok: false, error: `Local file not found: ${params.localPath}`, redactedSecretsCount: 0 }
  }

  // Q-6 pre-upload content scan on text files <= 5MB
  const st = statSync(params.localPath)
  if (st.isFile() && st.size <= 5 * 1024 * 1024) {
    const sample = readFileSync(params.localPath, 'utf8')
    const scan = redactSecrets(sample)
    if (scan.redactedCount > 0) {
      return {
        repoId,
        pathInRepo,
        ok: false,
        error: `Blocked upload: detected ${scan.redactedCount} unredacted secret(s) in ${params.localPath} (Q-6).`,
        redactedSecretsCount: scan.redactedCount,
      }
    }
  }

  const script = [
    buildHfPythonHeader(),
    'from huggingface_hub import HfApi',
    'api = HfApi()',
    'info = api.upload_file(path_or_fileobj=sys.argv[2], path_in_repo=sys.argv[3], repo_id=sys.argv[1], repo_type="dataset")',
    'print(json.dumps({"url": str(info)}, ensure_ascii=False))',
  ].join('\n')

  const res = await runner('python', ['-c', script, repoId, params.localPath, pathInRepo], { timeoutMs: 60000 })
  if (res.exitCode !== 0 && !params.runner && /No module named 'huggingface_hub'/.test(res.stderr)) {
    const codespace = process.env.EVERGREEN_CODESPACE || DEFAULT_CODESPACE_NAME
    const remoteTmp = `/tmp/hf_upload_${Date.now()}_${basename(params.localPath).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const cpRes = await runner('gh', ['codespace', 'cp', '-c', codespace, params.localPath, `remote:${remoteTmp}`], {
      timeoutMs: 45000,
    })
    if (cpRes.exitCode !== 0) {
      const err = sanitizeOutput(cpRes.stderr || cpRes.stdout)
      return { repoId, pathInRepo, ok: false, error: err.text, redactedSecretsCount: err.redactedCount }
    }
    const remotePy = `bash -lc "/home/codespace/.everos-venv/bin/python3 -c 'import json,os; from huggingface_hub import HfApi; tok=json.load(open(\\\"/workspaces/.codespaces/shared/user-secrets-envs.json\\\")).get(\\\"HF_TOKEN\\\") or os.environ.get(\\\"HF_TOKEN\\\"); info=HfApi(token=tok).upload_file(path_or_fileobj=\\\"${remoteTmp}\\\", path_in_repo=\\\"${pathInRepo}\\\", repo_id=\\\"${repoId}\\\", repo_type=\\\"dataset\\\"); print(json.dumps({\\\"url\\\": str(info)}))' ; rm -f \\\"${remoteTmp}\\\""`
    const upRes = await runner('gh', ['codespace', 'ssh', '-c', codespace, '--', remotePy], { timeoutMs: 60000 })
    if (upRes.exitCode !== 0) {
      const err = sanitizeOutput(upRes.stderr || upRes.stdout)
      return { repoId, pathInRepo, ok: false, error: err.text, redactedSecretsCount: err.redactedCount }
    }
    try {
      const parsed = JSON.parse(upRes.stdout.trim())                    
      const red = sanitizeOutput(parsed.url ?? '')
      return { repoId, pathInRepo, ok: true, url: red.text, redactedSecretsCount: red.redactedCount }
    } catch {
      return { repoId, pathInRepo, ok: true, redactedSecretsCount: 0 }
    }
  }
  if (res.exitCode !== 0) {
    const err = sanitizeOutput(res.stderr || res.stdout)
    return { repoId, pathInRepo, ok: false, error: err.text, redactedSecretsCount: err.redactedCount }
  }
  try {
    const parsed = JSON.parse(res.stdout)                    
    const red = sanitizeOutput(parsed.url ?? '')
    return { repoId, pathInRepo, ok: true, url: red.text, redactedSecretsCount: red.redactedCount }
  } catch {
    return { repoId, pathInRepo, ok: true, redactedSecretsCount: 0 }
  }
}

export async function hfVaultStatus(params    
                 
                           
                        
 )                                                                                                                                                                  {
  const repoId = params?.repoId || process.env.EVERGREEN_HF_VAULT_REPO || DEFAULT_HF_VAULT_REPO
  const customRunner = params?.runner
  const runner = customRunner ?? defaultSubprocessRunner
  const fetchFn = params?.fetchFn ?? globalThis.fetch.bind(globalThis)

  if (!customRunner || params?.fetchFn) {
    try {
      const apiUrl = `https://huggingface.co/api/datasets/${repoId}`
      const { response: resp } = await fetchHfWithAuth(apiUrl, { runner, fetchFn, timeoutMs: 15000 })
      if (!resp || !resp.ok) {
        const err = sanitizeOutput(`HF dataset_info HTTP ${resp?.status ?? 0}: ${resp?.statusText ?? 'No response'}`)
        return { repoId, reachable: false, error: err.text, redactedSecretsCount: err.redactedCount }
      }
      const info = (await resp.json())                                                                      
      return {
        repoId,
        reachable: true,
        privateRepo: Boolean(info.private),
        lastModified: info.lastModified,
        fileCount: Array.isArray(info.siblings) ? info.siblings.length : undefined,
        redactedSecretsCount: 0,
      }
    } catch (err) {
      const errRed = sanitizeOutput(err instanceof Error ? err.message : String(err))
      return { repoId, reachable: false, error: errRed.text, redactedSecretsCount: errRed.redactedCount }
    }
  }

  const script = [
    buildHfPythonHeader(),
    'from huggingface_hub import HfApi',
    'api = HfApi()',
    'info = api.dataset_info(repo_id=sys.argv[1])',
    'siblings = getattr(info, "siblings", None) or []',
    'print(json.dumps({"private": bool(getattr(info, "private", False)), "lastModified": str(getattr(info, "last_modified", "")), "fileCount": len(siblings)}, ensure_ascii=False))',
  ].join('\n')

  const res = await runner('python', ['-c', script, repoId], { timeoutMs: 20000 })
  if (res.exitCode !== 0) {
    const err = sanitizeOutput(res.stderr || res.stdout)
    return { repoId, reachable: false, error: err.text, redactedSecretsCount: err.redactedCount }
  }
  try {
    const parsed = JSON.parse(res.stdout)                                                                    
    return {
      repoId,
      reachable: true,
      privateRepo: parsed.private,
      lastModified: parsed.lastModified,
      fileCount: parsed.fileCount,
      redactedSecretsCount: 0,
    }
  } catch {
    const err = sanitizeOutput(res.stdout)
    return { repoId, reachable: false, error: err.text, redactedSecretsCount: err.redactedCount }
  }
}
