// dsh-modlens-vision-bridge
// ---------------------------------------------------------------------------
// Standalone vision-routing patch that REPLACES the in-modlens hack.
//
// WHY THIS EXISTS
//   DSH only lets the UI attach an image when resolveModelInfo().inputModalities
//   contains 'image'. For a text-only model we therefore list it in the host
//   provider's imageModelIds (UI admission) BUT that same declaration makes
//   modlens's nativeVisionGate / autoRead treat it as a native-vision model and
//   skip the OCR bridge, handing the raw picture to a model that cannot read
//   it. This plugin is the single decision point that forces such routes back
//   to "text-only -> OCR" — without editing modlens itself.
//
// HOW IT WORKS
//   It wraps ctx.llm.resolveModelInfo (write-through to the shared llm service,
//   verified). For a configured bridge route:
//     * 2-arg callers (admission gate, catalog build, ACP advertise) get the
//       info WITH inputModalities intact -> the UI still lets you attach a
//       picture and the admission gate stays green.
//     * 3-arg callers (modlens nativeVisionGate + autoRead, host image
//       projection) get the info with inputModalities stripped -> the route
//       reads as text-only, so modlens keeps its bridge tool visible and
//       autoRead OCRs the image instead of passing a raw picture to a blind
//       model.
//   Stock modlens is never touched. nativeVisionModels are vetoed (never
//   degraded to OCR). Non-listed routes pass through untouched.
//
// AUTO-PROBE
//   After the wrapper is installed, a BACKGROUND pass (delayed, budgeted, never
//   blocking apply()) enumerates every model the host knows about, probes the
//   ones that are not classified yet with a random-code PNG, and classifies
//   them: READS -> nativeVisionModels, REFUSED -> bridgeRoutes. Verdicts are
//   pushed into the LIVE tables immediately AND persisted to
//   <plugin>/state/probe-cache.json, which is folded back into the tables
//   SYNCHRONOUSLY during the next apply() — so the classification is already in
//   force for the very first resolveModelInfo call after a restart.
//
// SELF-CONTAINED
//   The plugin reads and writes only files inside its own directory (state/).
//   It never reads ~/.modlens and never rewrites the profile's
//   cordis.patch.yml: a REFUSED model whose provider does not advertise 'image'
//   yet is recorded as needsPairing and NOT bridged (a bridge with no image
//   intake would be a dead route); the user pairs it in imageModelIds.

import { loadCache, restoreVerdicts as restoreFromStore, verdictToPush } from './lib/verdictStore.mjs'

export const name = 'modlens-vision-bridge'
export const inject = ['llm']

const PATCH = '1.2.0'
const MARKER = '__visionBridgeWrapped'

// decision tables (config <- state/probe-cache.json at apply time)
let configured = false
let bridges = []
let nativeGuards = []
let pending = []

const validEntry = (e) => e && (e.provider !== undefined || e.model !== undefined)
const normalize = (list) =>
  (Array.isArray(list) ? list : [])
    .filter(validEntry)
    .map((e) => ({ provider: e.provider, model: e.model }))
const hit = (e, provider, model) =>
  (e.provider === undefined || e.provider === provider) && (e.model === undefined || e.model === model)

export function isNativeVision(provider, model) {
  return nativeGuards.some((e) => hit(e, provider, model))
}
export function isBridged(provider, model) {
  if (!configured) return false
  if (isNativeVision(provider, model)) return false
  return bridges.some((e) => hit(e, provider, model))
}

function configure(cfg = {}) {
  bridges = normalize(cfg.bridgeRoutes)
  nativeGuards = normalize(cfg.nativeVisionModels)
  pending = []
  configured = true
}

// Push a verified verdict into the LIVE arrays. Idempotent; a model that reads
// images is removed from bridges (never OCR a model that can see).
function pushVerdict(table, provider, model) {
  const arr = table === 'nativeGuards' ? nativeGuards : bridges
  const other = table === 'nativeGuards' ? bridges : nativeGuards
  let changed = false
  const at = other.findIndex((e) => e.provider === provider && e.model === model)
  if (at >= 0) {
    other.splice(at, 1)
    changed = true
  }
  if (!arr.some((e) => e.provider === provider && e.model === model)) {
    arr.push({ provider, model })
    changed = true
  }
  return changed
}

// Drop a live bridge entry (used when the route loses its image intake, i.e. the
// pairing was removed from imageModelIds: a bridge with no intake is a dead route).
function unbridge(provider, model) {
  const at = bridges.findIndex((e) => e.provider === provider && e.model === model)
  if (at < 0) return false
  bridges.splice(at, 1)
  return true
}

// Fold persisted verdicts into the tables. Synchronous by design: it runs BEFORE
// installWrapper() so the very first resolveModelInfo call after a restart
// already reflects the stored classification (no re-probe, no window where a
// bridged model looks native).
function restoreFromCache() {
  let v
  try {
    v = restoreFromStore(loadCache())
  } catch {
    return 0
  }
  let n = 0
  // Native verdicts first: a model that can see must never appear in bridges,
  // even if a manual bridge entry (config) names it — pushVerdict removes it.
  for (const e of v.nativeGuards) if (pushVerdict('nativeGuards', e.provider, e.model)) n++
  for (const e of v.bridges) {
    if (isNativeVision(e.provider, e.model)) continue
    if (pushVerdict('bridges', e.provider, e.model)) n++
  }
  pending = v.pending
  return n
}

// Install the resolveModelInfo wrapper onto the (shared) llm service.
// Idempotent: a hot-reload re-run is a no-op thanks to MARKER.
// Returns a disposer that restores the original function.
function installWrapper(llm) {
  // Already wrapped (hot reload of this plugin): do NOT wrap twice, but still
  // hand back a disposer that restores the ORIGINAL function — otherwise a
  // reload would leave the wrapper on the shared service forever.
  if (llm.resolveModelInfo && llm.resolveModelInfo[MARKER]) {
    const prev = llm.resolveModelInfo
    return () => {
      if (llm.resolveModelInfo === prev && prev.__visionBridgeOrig) {
        llm.resolveModelInfo = prev.__visionBridgeOrig
      }
    }
  }
  const orig = llm.resolveModelInfo
  const wrapped = async function resolveModelInfo(provider, model, signal) {
    const info = await orig.call(this, provider, model, signal)
    if (!isBridged(provider, model)) return info
    // Bridged route: keep inputModalities for 2-arg callers (UI admission /
    // catalog), strip it for 3-arg callers (modlens gate + autoRead, host
    // projection) so the route reads as text-only and the OCR bridge runs.
    if (arguments.length <= 2) return info
    if (info && typeof info === 'object') {
      const { inputModalities, ...rest } = info
      void inputModalities
      return rest
    }
    return info
  }
  Object.defineProperty(wrapped, MARKER, { value: true, enumerable: false })
  // Remember the function we replaced so a later reload's disposer can put it
  // back instead of leaving the wrapper installed on the shared service.
  Object.defineProperty(wrapped, '__visionBridgeOrig', { value: orig, enumerable: false })
  llm.resolveModelInfo = wrapped
  return () => {
    if (llm.resolveModelInfo === wrapped) llm.resolveModelInfo = orig
  }
}

// Background pass: delayed so it never competes with startup / the apply-time
// live-agent scan, budgeted so a slow endpoint cannot pile up, and wrapped so a
// failure only logs. Runs once per process.
let disposed = false
let probedOnce = false

// `unref()` keeps a pending probe timer from holding the host process open at
// shutdown. The timer handle shape differs between timers/promises and the
// classic one, so we accept whichever exists.
const delay = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    if (t && typeof t.unref === 'function') t.unref()
  })

async function startProbePass(ctx, config) {
  if (disposed || probedOnce) return
  probedOnce = true
  let runner
  try {
    runner = await import('./lib/probeRunner.mjs')
  } catch (e) {
    ctx.logger?.warn?.(`vision-bridge: probe module unavailable: ${e.message}`)
    return
  }
  const cfg = runner.probeConfig(config)
  if (!cfg.enabled) return
  await delay(cfg.delayMs)
  if (disposed) return
  try {
    const stats = await runner.runProbePass({
      llm: ctx.llm,
      config,
      onVerdict: (v) => {
        if (disposed) return
        const push = verdictToPush(v)
        if (!push) {
          // REFUSED but unpaired: keep it out of the live bridge table too, so a
          // removed pairing cannot leave a dead route behind until the restart.
          if (v.verdict === 'REFUSED' && unbridge(v.provider, v.model)) {
            ctx.logger?.info?.(`vision-bridge: ${v.provider}/${v.model} lost its image intake — bridge disabled`)
            return
          }
          ctx.logger?.info?.(
            `vision-bridge: ${v.provider}/${v.model} is text-only but has no image intake — ` +
              `add it to that provider's imageModelIds to enable the bridge`,
          )
          return
        }
        if (pushVerdict(push.table, v.provider, v.model)) {
          ctx.logger?.info?.(`vision-bridge: probe ${v.verdict} ${v.provider}/${v.model} -> ${push.table}`)
        }
      },
      onLog: (msg) => ctx.logger?.info?.(`vision-bridge: ${msg}`),
    })
    if (stats.verdicts.length) {
      ctx.logger?.info?.(
        `vision-bridge: probe pass classified ${stats.verdicts.length} model(s); ` +
          'verdicts persisted in state/probe-cache.json',
      )
    }
  } catch (e) {
    ctx.logger?.warn?.(`vision-bridge: probe pass failed: ${e.message}`)
  }
}

export function apply(ctx, config = {}) {
  configure(config)
  // Synchronous restore, before the wrapper is installed and long before any
  // request is served: this is what makes the classification survive a restart
  // without re-probing.
  try {
    const n = restoreFromCache()
    if (n) {
      ctx.logger?.info?.(`vision-bridge: restored ${n} probe verdict(s) from state/probe-cache.json`)
    }
    if (pending.length) {
      ctx.logger?.info?.(
        `vision-bridge: ${pending.length} text-only model(s) still need imageModelIds pairing: ` +
          pending.map((e) => `${e.provider}/${e.model}`).join(', '),
      )
    }
  } catch (e) {
    ctx.logger?.warn?.(`vision-bridge: verdict restore skipped: ${e.message}`)
  }
  disposed = false
  probedOnce = false
  // `llm` is in our inject list, so ctx.llm is available and safe here.
  // Installing synchronously during apply (this plugin is ordered before
  // modlens in dsh.profile.bundles) guarantees the wrapper is in place before
  // modlens's apply-time live-agent scan probes resolveModelInfo.
  const restore = installWrapper(ctx.llm)
  // Background probe: scheduled, delayed and budgeted; `unref()` so a pending
  // timer can never hold the host process open at shutdown.
  if (config.autoProbe !== false) {
    Promise.resolve()
      .then(() => startProbePass(ctx, config))
      .catch((e) => ctx.logger?.warn?.(`vision-bridge: probe task error: ${e.message}`))
  }
  ctx.on('dispose', () => {
    disposed = true
    // A probe already in flight must not write verdicts into a dead instance.
    probedOnce = true
    restore && restore()
  })
}

// Inspection hook for the selftests / a status tool.
export function probeStatus() {
  let cache = null
  let needsPairing = pending
  try {
    // Recomputed from the CURRENT cache, not from the snapshot taken at apply():
    // the background pass writes verdicts while the host is running.
    const v = restoreFromStore(loadCache())
    needsPairing = v.pending
    cache = { native: v.nativeGuards, bridged: v.bridges, needsPairing: v.pending, skipped: v.skipped }
  } catch {
    cache = null
  }
  return {
    version: PATCH,
    bridgeRoutes: [...bridges],
    nativeVisionModels: [...nativeGuards],
    pendingPairing: needsPairing,
    cache,
  }
}
