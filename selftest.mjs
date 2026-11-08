// Offline selftest for dsh-modlens-vision-bridge.
// Run: node selftest.mjs   (exit 0 = pass)
//
// No real host, no ports. We fake the cordis ctx and the llm service, and we
// faithfully reproduce the host's proxy trap: reading an un-injected service
// name throws `cannot get property "<name>" without inject`.
import assert from 'node:assert/strict'
import { apply, isBridged, isNativeVision } from './index.js'

const PATCH_CONFIG = {
  bridgeRoutes: [
    { provider: 'workbuddy', model: 'hy3' },
    { provider: 'workbuddy-global', model: 'hy3' },
    { provider: 'workbuddy', model: 'hy4free' },
    { provider: 'workbuddy-global', model: 'hy4free' },
  ],
  nativeVisionModels: [
    { provider: 'workbuddy', model: 'glm-5.3-flash' },
    { provider: 'workbuddy-global', model: 'glm-5.3-flash' },
  ],
}

function makeFakeLlm() {
  // A fake shared llm service. resolveModelInfo returns inputModalities so the
  // wrapper has something to strip / keep.
  return {
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      context: 100000,
    }),
  }
}

// Faithful fake ctx: 'llm' IS injected (ctx.llm + get('llm') both work); every
// other service read throws `cannot get property "<name>" without inject` like
// the real Cordis proxy. on() captures handlers so we can fire 'dispose'.
function makeCtx() {
  const llmService = makeFakeLlm()
  const handlers = {}
  const ctx = {
    inject: ['llm'],
    on(name, fn) {
      handlers[name] = fn
      return () => {}
    },
    get(name) {
      if (name === 'llm') return llmService
      return undefined // inject-free lookup: missing -> undefined, never throw
    },
    _handlers: handlers,
  }
  Object.defineProperty(ctx, 'llm', { value: llmService, enumerable: true })
  Object.defineProperty(ctx, 'workspaceRegistry', {
    get() {
      throw new Error('cannot get property "workspaceRegistry" without inject')
    },
  })
  return ctx
}

let passed = 0
function ok(label) {
  passed++
  console.log(`ok ${label}`)
}

// --- decision tables ---
;(() => {
  apply(makeCtx(), PATCH_CONFIG)
  assert.equal(isBridged('workbuddy', 'hy3'), true)
  assert.equal(isBridged('workbuddy-global', 'hy4free'), true)
  assert.equal(isBridged('workbuddy', 'glm-5.3-flash'), false, 'native vetoed')
  assert.equal(isBridged('workbuddy', 'other'), false, 'not listed')
  ok('decision tables: bridged/native/other')
})()

// --- stub fidelity: un-injected read throws, get works ---
;(() => {
  const ctx = makeCtx()
  assert.throws(() => ctx.workspaceRegistry, /cannot get property "workspaceRegistry" without inject/)
  assert.ok(ctx.get('llm'), 'get("llm") returns service')
  ok('fake-ctx fidelity: throws on un-injected read, get works')
})()

// --- wrapper: 2-arg keeps inputModalities, 3-arg strips ---
;(() => {
  const ctx = makeCtx()
  apply(ctx, PATCH_CONFIG)
  const llm = ctx.get('llm')
  assert.equal(typeof llm.resolveModelInfo, 'function')

  ;(async () => {
    const r2 = await llm.resolveModelInfo('workbuddy', 'hy3') // no signal arg
    assert.deepEqual(
      r2.inputModalities,
      ['text', 'image'],
      '2-arg keeps inputModalities (UI admission/catalog)',
    )

    const three = await llm.resolveModelInfo('workbuddy', 'hy3', undefined)
    assert.equal(
      three.inputModalities,
      undefined,
      '3-arg strips inputModalities (modlens gate/autoRead)',
    )
    assert.equal(three.provider, 'workbuddy')
    assert.equal(three.id, 'hy3')

    // non-bridged stays intact regardless of args
    const other = await llm.resolveModelInfo('workbuddy', 'other', undefined)
    assert.deepEqual(other.inputModalities, ['text', 'image'])

    // native-vision models are NOT stripped even with 3 args
    const native = await llm.resolveModelInfo('workbuddy', 'glm-5.3-flash', undefined)
    assert.deepEqual(native.inputModalities, ['text', 'image'], 'native kept')

    ok('wrapper: 2-arg keep, 3-arg strip, non-bridged/native untouched')
  })()
})()

// --- idempotent: double apply does not double-wrap ---
;(() => {
  const ctx = makeCtx()
  const llm = ctx.get('llm')
  const orig = llm.resolveModelInfo
  apply(ctx, PATCH_CONFIG)
  const once = llm.resolveModelInfo
  apply(ctx, PATCH_CONFIG) // re-run (hot reload)
  assert.equal(llm.resolveModelInfo, once, 're-apply does not re-wrap')
  assert.notEqual(llm.resolveModelInfo, orig)
  ok('idempotent against double apply')
})()

// --- dispose restores original ---
;(() => {
  const ctx = makeCtx()
  const llm = ctx.get('llm')
  const orig = llm.resolveModelInfo
  apply(ctx, PATCH_CONFIG)
  assert.notEqual(llm.resolveModelInfo, orig, 'wrapper installed')
  const restore = ctx._handlers['dispose']
  assert.equal(typeof restore, 'function', 'dispose handler registered')
  restore()
  assert.equal(llm.resolveModelInfo, orig, 'dispose restores original fn')
  ok('dispose restores original resolveModelInfo')
})()

console.log(`\nALL CHECKS PASSED (${passed} groups)`)
