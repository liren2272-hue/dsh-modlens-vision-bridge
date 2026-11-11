// dsh-modlens-vision-bridge — background probe orchestrator.
// ---------------------------------------------------------------------------
// Runs once per DSH start, AFTER the resolveModelInfo wrapper is installed, on a
// timer (so it never delays startup and never touches the apply-time scan).
//
// What it does:
//   1. asks ctx.llm.listModels() for every provider we know about;
//   2. skips anything already classified (config lists + state/probe-cache.json);
//   3. probes each remaining model with a random-code PNG;
//   4. READS   -> nativeVisionModels (never OCR-degrade a model that can see)
//      REFUSED -> bridgeRoutes     (only if the UI can actually attach an image,
//                                   i.e. inputModalities already has 'image';
//                                   otherwise we record needsPairing and wait)
//   5. persists every verdict into <plugin>/state/probe-cache.json, so the next
//      start re-derives the same tables before any request is served.
//
// Transports, in order of preference:
//   * ctx.llm.visionProbe  — host-mediated (dsh-connect-workbuddy exposes it on
//     the shared llm service). No port, no HTTP, no credentials.
//   * direct HTTP          — credentials from THIS plugin's own files only:
//     config.probe.credentials, else <plugin>/state/probe-credentials.json
//     ({ "<provider>": { "baseUrl": "...", "apiKey": "..." } }). Never read from
//     ~/.modlens or any other directory.
// Every throw is caught and logged; a probe failure must never break plugin load.

import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { probeOne, genProbeImage, randomCode } from './probe.mjs'
import { STATE_DIR, cacheKey, loadCache, saveCache, verdictToPush } from './verdictStore.mjs'

const DEFAULT_PROVIDERS = ['workbuddy', 'workbuddy-global', 'officeace']
const PROBE_BUDGET_MS = 180_000 // one start's total probe budget; overrun just stops
const CRED_PATH = join(STATE_DIR, 'probe-credentials.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The probe PNG is written INSIDE the plugin dir (state/) and deleted right
// after it is encoded — a temp dir would violate the own-directory rule.
function makeImage() {
  mkdirSync(STATE_DIR, { recursive: true })
  const code = randomCode()
  const png = genProbeImage(code, join(STATE_DIR, `probe-${code}.png`))
  try {
    return { code, dataUrl: `data:image/png;base64,${readFileSync(png).toString('base64')}` }
  } finally {
    try {
      unlinkSync(png)
    } catch {
      /* best effort */
    }
  }
}

export function probeConfig(config = {}) {
  const p = config.probe && typeof config.probe === 'object' ? config.probe : {}
  return {
    enabled: config.autoProbe !== false && p.enabled !== false,
    delayMs: Number.isFinite(p.delayMs) ? p.delayMs : 8000,
    providers: Array.isArray(p.providers) && p.providers.length ? p.providers : DEFAULT_PROVIDERS,
    credentials: Array.isArray(p.credentials) ? p.credentials : [],
  }
}

// Provider credentials, from the plugin's own directory only.
function loadCredentialFile() {
  try {
    if (!existsSync(CRED_PATH)) return {}
    const j = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function credentialFor(creds, file, provider) {
  const c = creds.find((e) => e && e.provider === provider && e.baseUrl && e.apiKey)
  if (c) return { base: c.baseUrl, key: c.apiKey }
  const f = file[provider]
  if (f && f.baseUrl && f.apiKey) return { base: f.baseUrl, key: f.apiKey }
  return null
}

// Can the UI even attach an image to this route? True only when the provider's
// imageModelIds already includes the model. We must never auto-add that (it is
// the user's patch layer), so a REFUSED model without intake is parked as
// "needsPairing" instead of being bridged into a dead end.
async function hasImageIntake(llm, provider, model) {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

export async function runProbePass({ llm, config = {}, onVerdict, onLog, now = Date.now }) {
  const p = probeConfig(config)
  if (!p.enabled) {
    onLog?.('probe disabled by config')
    return { probed: 0, skipped: 0, verdicts: [] }
  }
  const deadline = now() + PROBE_BUDGET_MS
  const cache = loadCache()
  const credFile = loadCredentialFile()
  const image = makeImage()
  const hostProbe = typeof llm?.visionProbe === 'function' ? llm.visionProbe.bind(llm) : null
  const stats = { probed: 0, skipped: 0, verdicts: [] }

  for (const provider of p.providers) {
    if (now() > deadline) {
      onLog?.('probe budget exhausted — remaining models stay unclassified this start')
      break
    }
    let models = []
    try {
      const raw = await llm.listModels(provider)
      models = (Array.isArray(raw) ? raw : [])
        .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model))
        .filter((m) => typeof m === 'string' && m)
    } catch (e) {
      onLog?.(`listModels(${provider}) failed: ${e.message}`)
      continue
    }
    if (models.length === 0) continue
    const cred = credentialFor(p.credentials, credFile, provider)
    // One clear line per provider instead of N silent skips: without a host hook
    // or plugin-local credentials we genuinely cannot probe this batch.
    if (!hostProbe && !cred) {
      const pending = models.filter((m) => {
        const c = cache[cacheKey(provider, m)]
        return !c || (c.verdict !== 'READS' && c.verdict !== 'REFUSED')
      })
      if (pending.length) {
        onLog?.(
          `${provider}: ${pending.length} unclassified model(s) but no transport — ` +
            'add state/probe-credentials.json ({"' + provider + '":{"baseUrl":"…","apiKey":"…"}}) ' +
            'or expose ctx.llm.visionProbe',
        )
      }
      stats.skipped += pending.length
      continue
    }

    for (const model of models) {
      if (now() > deadline) break
      const key = cacheKey(provider, model)
      const cached = cache[key]
      // A "needsPairing" verdict is provisional: the user may have added the
      // model to imageModelIds since. Re-check the intake and promote it to a
      // real bridge the moment the route can actually receive a picture —
      // without re-probing the model.
      if (cached?.verdict === 'REFUSED' && cached.needsPairing) {
        if (await hasImageIntake(llm, provider, model)) {
          cache[key] = { ...cached, needsPairing: false, probedAt: now() }
          saveCache(cache)
          onLog?.(`probe ${provider}/${model} -> pairing detected, promoting to bridges`)
          onVerdict?.({ provider, model, ...cache[key] })
        }
        continue
      }
      if (cached && (cached.verdict === 'READS' || cached.verdict === 'REFUSED')) continue
      let r
      try {
        if (hostProbe) {
          r = await hostProbe({ provider, model, imageDataUrl: image.dataUrl, code: image.code })
        } else if (cred) {
          r = await probeOne(cred.base, cred.key, image.dataUrl, model, { code: image.code })
        } else {
          stats.skipped++
          continue // no transport for this provider: not a verdict, retry next start
        }
      } catch (e) {
        onLog?.(`probe ${provider}/${model} errored: ${e.message}`)
        continue
      }
      r = r || { verdict: 'UNCLEAR' }
      if (r.verdict !== 'READS' && r.verdict !== 'REFUSED') {
        onLog?.(`probe ${provider}/${model} -> ${r.verdict} (not a verdict, retry next start)`)
        continue // QUOTA / UNCLEAR / SKIP are never persisted
      }
      if (r.verdict === 'REFUSED') {
        const intake = await hasImageIntake(llm, provider, model)
        cache[key] = { verdict: 'REFUSED', why: r.why, needsPairing: !intake, probedAt: now() }
      } else {
        cache[key] = { verdict: 'READS', why: r.why, probedAt: now() }
      }
      saveCache(cache)
      stats.probed++
      const verdict = { provider, model, ...cache[key] }
      stats.verdicts.push(verdict)
      onLog?.(
        `probe ${provider}/${model} -> ${verdict.verdict}` +
          (verdict.needsPairing ? ' (no image intake yet: add to imageModelIds to bridge)' : ''),
      )
      onVerdict?.(verdict)
      await sleep(250) // be a polite background job, not a burst
    }
  }
  if (stats.probed === 0) onLog?.('probe pass finished: nothing new to classify')
  return stats
}

// Human-readable summary, used by probeStatus() and the startup log line.
export function probeSummary(cache = loadCache()) {
  const rows = Object.entries(cache).map(([key, v]) => {
    const [provider, model] = String(key).split('::')
    return { provider, model, verdict: v?.verdict, needsPairing: !!v?.needsPairing, probedAt: v?.probedAt }
  })
  return {
    total: rows.length,
    native: rows.filter((r) => r.verdict === 'READS').length,
    bridged: rows.filter((r) => r.verdict === 'REFUSED' && !r.needsPairing).length,
    needsPairing: rows.filter((r) => r.needsPairing).map((r) => `${r.provider}/${r.model}`),
    rows,
  }
}

export { verdictToPush }
