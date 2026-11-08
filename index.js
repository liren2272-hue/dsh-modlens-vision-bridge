// dsh-modlens-vision-bridge
// ---------------------------------------------------------------------------
// Standalone vision-routing patch that REPLACES the in-modlens hack.
//
// WHY THIS EXISTS (unchanged requirement, cleaner home)
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
// KNOWN, ACCEPTABLE REGRESSIONS (by design)
//   The host's own `read_image` tool and MCP image-admission precheck use an
//   UNPROTECTED `inputModalities === void 0 || !includes('image')` gate. On a
//   bridged text-only model they will refuse (they would otherwise hand a raw
//   picture to a blind model — the correct tool there is `modlens_read_image`).
//   The main chat flow (attach a photo -> modlens OCR) is unaffected.

export const name = 'modlens-vision-bridge'
export const inject = ['llm']

const PATCH = '1.0.0'
const MARKER = '__visionBridgeWrapped'

// decision tables (mirrors the old ~/.modlens/vision-routing/visionRouting.js)
let configured = false
let bridges = []
let nativeGuards = []

const validEntry = (e) =>
  e && (e.provider !== undefined || e.model !== undefined)
const normalize = (list) =>
  (Array.isArray(list) ? list : [])
    .filter(validEntry)
    .map((e) => ({ provider: e.provider, model: e.model }))
const hit = (e, provider, model) =>
  (e.provider === undefined || e.provider === provider) &&
  (e.model === undefined || e.model === model)

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
  configured = true
}

// Install the resolveModelInfo wrapper onto the (shared) llm service.
// Idempotent: a hot-reload re-run is a no-op thanks to MARKER.
// Returns a disposer that restores the original function.
function installWrapper(llm, config) {
  if (llm.resolveModelInfo && llm.resolveModelInfo[MARKER]) return () => {}
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
  llm.resolveModelInfo = wrapped
  return () => {
    if (llm.resolveModelInfo === wrapped) llm.resolveModelInfo = orig
  }
}

export function apply(ctx, config = {}) {
  configure(config)
  // `llm` is in our inject list, so ctx.llm is available and safe here.
  // Installing synchronously during apply (this plugin is ordered before
  // modlens in dsh.profile.bundles) guarantees the wrapper is in place before
  // modlens's apply-time live-agent scan probes resolveModelInfo.
  const restore = installWrapper(ctx.llm, config)
  ctx.on('dispose', () => restore && restore())
}
