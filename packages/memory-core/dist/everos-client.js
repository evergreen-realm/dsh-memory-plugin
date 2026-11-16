/** Zero-dependency EverOS HTTP client (/health, /api/v2/memory/add, /flush, /search). */

             
             
              
             
               
                
               
                 
                   

export const EVEROS_ADD_MAX_MESSAGES = 500
const PATH_SAFE = /^[a-zA-Z0-9_.@+-]+$/u

export class EverosClientError extends Error {
           status        
           path         

  constructor(
    status        ,
    message        ,
    path         ,
  ) {
    super(message)
    this.name = 'EverosClientError'
    this.status = status
    this.path = path
  }
}

                                  
                                                                        
                                                                
                                                                      
         
          
                      
                       
                     
                         
                   
                           
                    
                               
      
                       
                            
 

export function sanitizeScopeId(raw                    , fallback        )         {
  const s = (raw ?? '').trim() || fallback
  if (s !== '.' && s !== '..' && s.length <= 128 && PATH_SAFE.test(s)) {
    return s
  }
  const cleaned = s.replace(/[^a-zA-Z0-9_.@+-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return (cleaned || fallback).slice(0, 128)
}

export class HttpEverosClient                            {
          negotiated                                         
                   baseUrl        
                   apiVersion            
                   fetchFn              

  constructor(
    baseUrl        ,
    apiVersion             = 'auto',
    fetchFn               = fetch,
  ) {
    this.baseUrl = baseUrl
    this.apiVersion = apiVersion
    this.fetchFn = fetchFn
    if (apiVersion !== 'auto') this.negotiated = apiVersion
  }

          async request   (method                , subpath        , body          , timeoutMs = 5000)             {
    const cleanBase = this.baseUrl.replace(/\/+$/u, '')
    const candidates                                     = this.negotiated
      ? [this.negotiated]
      : ['v2', 'v1']

    if (subpath === '/health') {
      const res = await this.fetchFn(`${cleanBase}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new EverosClientError(res.status, `EverOS /health HTTP ${res.status}`, '/health')
      return (await res.json())     
    }

    let lastErr         
    for (const ver of candidates) {
      const url = `${cleanBase}/api/${ver}${subpath}`
      const res = await this.fetchFn(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 404 && !this.negotiated && ver === 'v2') {
        lastErr = new EverosClientError(404, 'EverOS v2 endpoint missing; retrying v1', url)
        continue
      }
      if (!res.ok) {
        throw new EverosClientError(res.status, `EverOS ${url} failed with HTTP ${res.status}`, url)
      }
      this.negotiated = ver
      const parsed = (await res.json())                                
      if (parsed && typeof parsed === 'object') {
        if ('data' in parsed && parsed.data !== undefined) return parsed.data     
        if ('result' in parsed && parsed.result !== undefined) return parsed.result     
      }
      return parsed     
    }
    throw lastErr instanceof Error ? lastErr : new EverosClientError(500, 'EverOS request failed')
  }

  async health(timeoutMs = 3000)                                             {
    const raw = await this.request                         ('GET', '/health', undefined, timeoutMs)
    return { status: typeof raw.status === 'string' ? raw.status : 'ok', raw }
  }

  async add(req            , timeoutMs = 15000)                       {
    const safeSession = sanitizeScopeId(req.session_id, 'session')
    let accumulated = 0
    let status                        = 'accumulated'

    // Honor EverOS 500-message per-request limit cleanly via chunking
    for (let i = 0; i < req.messages.length; i += EVEROS_ADD_MAX_MESSAGES) {
      const chunk = req.messages.slice(i, i + EVEROS_ADD_MAX_MESSAGES)
      const res = await this.request             (
        'POST',
        '/memory/add',
        {
          session_id: safeSession,
          app_id: req.app_id ? sanitizeScopeId(req.app_id, 'default') : undefined,
          project_id: req.project_id ? sanitizeScopeId(req.project_id, 'default') : undefined,
          messages: chunk,
          defer_extraction: req.defer_extraction ?? true,
        },
        timeoutMs,
      )
      accumulated += res.message_count ?? chunk.length
      status = res.status ?? status
    }

    return { message_count: accumulated, status }
  }

  async flush(req              , timeoutMs = 15000)                         {
    return this.request               (
      'POST',
      '/memory/flush',
      {
        session_id: sanitizeScopeId(req.session_id, 'session'),
        app_id: req.app_id ? sanitizeScopeId(req.app_id, 'default') : undefined,
        project_id: req.project_id ? sanitizeScopeId(req.project_id, 'default') : undefined,
      },
      timeoutMs,
    )
  }

  async search(
    req   
                      
                       
                     
                         
                   
                           
                    
                               
     ,
    timeoutMs = 5000,
  )                          {
    return this.request                (
      'POST',
      '/memory/search',
      {
        ...req,
        user_id: req.user_id
          ? sanitizeScopeId(req.user_id, 'user')
          : req.agent_id
            ? undefined
            : 'evergreen',
        agent_id: req.agent_id ? sanitizeScopeId(req.agent_id, 'agent') : undefined,
        app_id: req.app_id ? sanitizeScopeId(req.app_id, 'default') : undefined,
        project_id: req.project_id ? sanitizeScopeId(req.project_id, 'default') : undefined,
        method: req.method ?? 'hybrid',
        top_k: req.top_k ?? 5,
      },
      timeoutMs,
    )
  }
}
