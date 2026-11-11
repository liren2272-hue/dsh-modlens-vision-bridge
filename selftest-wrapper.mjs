// Selftest for the resolveModelInfo wrapper (the part that makes modlens OCR
// instead of handing a raw picture to a blind model).
// Run: node selftest-wrapper.mjs       (exit 0 = pass; no network, no host)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate state/ so the real probe cache is never read or written.
const SANDBOX = mkdtempSync(join(tmpdir(), 'vb-wrap-'))
process.env.VISION_BRIDGE_STATE_DIR = SANDBOX

const { apply, isBridged, isNativeVision, probeStatus } = await import('./index.js')

let passed = 0
const ok = (l) => {
  passed++
  console.log(`ok ${l}`)
}

const CONFIG = {
  autoProbe: false,
  bridgeRoutes: [
    { provider: 'workbuddy', model: 'hy3' },
    { provider: 'workbuddy-global', model: 'hy3' },
  ],
  nativeVisionModels: [{ provider: 'workbuddy', model: 'glm-5.3-flash' }],
}

// Fake shared llm service: every route advertises image, so stripping is visible.
function makeHost() {
  const llm = {
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      context: 100000,
    }),
  }
  const handlers = {}
  const ctx = {
    llm,
    logger: { info() {}, warn() {} },
    on: (n, f) => {
      handlers[n] = f
      return () => {}
    },
    _handlers: handlers,
  }
  return { ctx, llm }
}

// --- 1. bridged route: 2-arg keeps image, 3-arg strips it -----------------
{
  const { ctx, llm } = makeHost()
  const orig = llm.resolveModelInfo
  apply(ctx, CONFIG)

  const two = await llm.resolveModelInfo('workbuddy', 'hy3')
  assert.deepEqual(two.inputModalities, ['text', 'image'], '2-arg caller keeps image (UI admission)')
  const three = await llm.resolveModelInfo('workbuddy', 'hy3', undefined)
  assert.equal('inputModalities' in three, false, '3-arg caller loses inputModalities (modlens gate -> OCR)')
  assert.equal(three.id, 'hy3', 'other fields pass through')
  ok('bridged route: image kept for 2-arg, stripped for 3-arg')

  // --- 2. native veto + unlisted route are untouched ----------------------
  const native = await llm.resolveModelInfo('workbuddy', 'glm-5.3-flash', undefined)
  assert.deepEqual(native.inputModalities, ['text', 'image'], 'native model never degraded')
  const other = await llm.resolveModelInfo('officeace', 'something-else', undefined)
  assert.deepEqual(other.inputModalities, ['text', 'image'], 'unlisted route passes through untouched')
  ok('native veto + unlisted route untouched')

  // --- 3. wrapper is installed on the SHARED service (write-through) ------
  assert.notEqual(llm.resolveModelInfo, orig, 'wrapper replaced the method on the shared service')
  assert.equal(llm.resolveModelInfo.__visionBridgeWrapped, true, 'marker present')
  const marked = llm.resolveModelInfo
  apply(ctx, CONFIG) // hot reload
  assert.equal(llm.resolveModelInfo, marked, 'second apply() does not double-wrap')
  ok('write-through on shared service; idempotent re-apply')

  // --- 4. dispose restores the original ----------------------------------
  ctx._handlers.dispose()
  assert.equal(llm.resolveModelInfo, orig, 'dispose restores the original resolveModelInfo')
  ok('dispose restores the original method')

  // --- 5. nothing leaks into the tables after dispose --------------------
  assert.equal(isBridged('workbuddy', 'hy3'), true, 'tables still hold config (harmless)')
  assert.equal(isNativeVision('workbuddy', 'glm-5.3-flash'), true)
  ok('decision tables readable via exports')
}

// --- 6. probeStatus reports the effective state ---------------------------
{
  const { ctx } = makeHost()
  apply(ctx, CONFIG)
  const s = probeStatus()
  assert.equal(s.version, '1.2.0')
  assert.ok(s.bridgeRoutes.some((e) => e.model === 'hy3'))
  assert.ok(s.nativeVisionModels.some((e) => e.model === 'glm-5.3-flash'))
  assert.deepEqual(s.pendingPairing, [], 'fresh sandbox has no needsPairing entries')
  ok('probeStatus: version + effective tables + pending list')
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\nALL WRAPPER CHECKS PASSED (${passed} groups)`)
