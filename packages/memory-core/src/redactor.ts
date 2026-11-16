/** Secret redaction and opt-out guards (Q-6). */

import { existsSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

export interface RedactionResult {
  text: string
  redactedCount: number
}

const SECRET_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp; replacement: string }> = [
  { label: 'hf_token', regex: /\bhf_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED:HF_TOKEN]' },
  { label: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED:GITHUB_PAT]' },
  { label: 'github_classic', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED:GITHUB_TOKEN]' },
  { label: 'kaggle_token', regex: /\bKGAT_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED:KAGGLE_KEY]' },
  { label: 'google_oauth_secret', regex: /\bGOCSPX-[A-Za-z0-9_\-]{16,}\b/g, replacement: '[REDACTED:GOOGLE_OAUTH_SECRET]' },
  { label: 'google_api_key', regex: /\bAIza[0-9A-Za-z_\-]{20,}\b/g, replacement: '[REDACTED:GOOGLE_API_KEY]' },
  { label: 'nvidia_key', regex: /\bnvapi-[A-Za-z0-9_\-]{20,}\b/g, replacement: '[REDACTED:NVIDIA_KEY]' },
  { label: 'groq_key', regex: /\bgsk_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED:GROQ_KEY]' },
  { label: 'openai_like_key', regex: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_\-]{20,}\b/g, replacement: '[REDACTED:API_KEY]' },
  { label: 'cloudflare_token', regex: /\b(?:cf_|CF_API_TOKEN=)[A-Za-z0-9_\-]{20,}\b/g, replacement: '[REDACTED:CLOUDFLARE_TOKEN]' },
  { label: 'bearer_auth', regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, replacement: 'Bearer [REDACTED:TOKEN]' },
  { label: 'url_userinfo', regex: /https?:\/\/([^:@/\s]+):([^@/\s]{6,})@/gi, replacement: 'https://$1:[REDACTED:PASS]@' },
  {
    label: 'pem_private_key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:PEM_PRIVATE_KEY]',
  },
  {
    label: 'env_assignment',
    // Bound identifier affixes to prevent quadratic regex scanning on multi-megabyte unbroken tokens
    regex: /\b([A-Za-z0-9_]{0,64}(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]{0,64})\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,512})["']?/gi,
    replacement: '$1=[REDACTED:ENV_SECRET]',
  },
]

export function redactSecrets(input: string): RedactionResult {
  if (!input) return { text: input, redactedCount: 0 }
  let text = input
  let redactedCount = 0
  for (const rule of SECRET_PATTERNS) {
    rule.regex.lastIndex = 0
    const matches = text.match(rule.regex)
    if (matches && matches.length > 0) {
      redactedCount += matches.length
      text = text.replace(rule.regex, rule.replacement)
    }
  }
  return { text, redactedCount }
}

/**
 * Checks opt-out policy (Q-6):
 * 1. Inline pragma `[[memory:off]]` in prompt/content.
 * 2. Presence of a `.memory-off` marker file in cwd or any ancestor directory.
 */
export function isMemoryOptedOut(options: { cwd?: string; text?: string; env?: Record<string, string | undefined> }): boolean {
  const env = options.env ?? process.env
  if (env.EVERGREEN_MEMORY_OFF === '1' || env.EVERGREEN_MEMORY_OFF === 'true') {
    return true
  }
  if (options.text && /\[\[memory:off\]\]/i.test(options.text)) {
    return true
  }
  if (options.cwd) {
    let cur = resolve(options.cwd)
    const root = parse(cur).root
    while (true) {
      if (existsSync(join(cur, '.memory-off'))) return true
      if (cur === root) break
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return false
}
