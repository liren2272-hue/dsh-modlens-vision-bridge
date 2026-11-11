// dsh-modlens-vision-bridge — durable verdict store (own-dir only).
// ---------------------------------------------------------------------------
// HARD RULE: everything this plugin reads or writes lives INSIDE the plugin
// directory. We never read ~/.modlens/config.json and never rewrite the
// profile's cordis.patch.yml (that layer belongs to the user). Durable state:
//   <plugin>/state/probe-cache.json   verdicts (READS / REFUSED / needsPairing)
// Zero dependencies beyond node:fs so index.js can import it SYNCHRONOUSLY and
// fold verdicts into the live tables before the resolveModelInfo wrapper is
// installed (and therefore before modlens's apply-time live-agent scan).
//
// VISION_BRIDGE_STATE_DIR exists only so the selftests can point at a temp dir
// instead of clobbering the real cache; production never sets it.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url))) // lib/ -> plugin root
export const STATE_DIR = process.env.VISION_BRIDGE_STATE_DIR || join(PLUGIN_DIR, 'state')
export const CACHE_PATH = join(STATE_DIR, 'probe-cache.json')

export const cacheKey = (provider, model) => `${provider}::${model}`

export function loadCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {}
  } catch {
    return {}
  }
}

export function saveCache(cache) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${CACHE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, CACHE_PATH)
    return true
  } catch {
    return false
  }
}

export function putEntry(cache, provider, model, entry) {
  cache[cacheKey(provider, model)] = { ...entry, probedAt: entry.probedAt ?? Date.now() }
  saveCache(cache)
  return cache
}

// Probe verdict -> decision table. READS -> nativeGuards (放行原生, veto bridge),
// REFUSED -> bridges (force OCR) — but only when the route actually has image
// intake (needsPairing means it does not, so bridging would be a dead route).
// QUOTA / UNCLEAR / SKIP are NOT verdicts.
export function verdictToPush(v) {
  if (v?.verdict === 'READS') return { table: 'nativeGuards', entry: { provider: v.provider, model: v.model } }
  if (v?.verdict === 'REFUSED' && !v?.needsPairing) {
    return { table: 'bridges', entry: { provider: v.provider, model: v.model } }
  }
  return null
}

// Cache -> { bridges, nativeGuards, pending, skipped }. Synchronous and total.
export function restoreVerdicts(cache = loadCache()) {
  const out = { bridges: [], nativeGuards: [], pending: [], skipped: [] }
  for (const [key, v] of Object.entries(cache || {})) {
    const [provider, model] = String(key).split('::')
    if (!provider || !model) continue
    if (v?.verdict === 'READS') out.nativeGuards.push({ provider, model })
    else if (v?.verdict === 'REFUSED' && v?.needsPairing) out.pending.push({ provider, model, why: v.why })
    else if (v?.verdict === 'REFUSED') out.bridges.push({ provider, model })
    else out.skipped.push({ provider, model, verdict: v?.verdict })
  }
  return out
}
