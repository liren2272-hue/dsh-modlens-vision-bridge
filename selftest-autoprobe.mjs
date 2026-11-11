// Self-contained selftest for the auto-probe: probe kernel, verdict store,
// restart persistence and the "own directory only" rule.
// Run: node selftest-autoprobe.mjs      (exit 0 = pass; no network, no host)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(fileURLToPath(import.meta.url))
// Point the store at a scratch dir BEFORE importing anything that touches state.
const SANDBOX = mkdtempSync(join(tmpdir(), 'vb-selftest-'))
process.env.VISION_BRIDGE_STATE_DIR = SANDBOX

const { classifyResponse, genProbeImage, randomCode } = await import('./lib/probe.mjs')
const { saveCache, loadCache, verdictToPush } = await import('./lib/verdictStore.mjs')
const { runProbePass, probeConfig } = await import('./lib/probeRunner.mjs')
const plugin = await import('./index.js')

let passed = 0
const ok = (l) => {
  passed++
  console.log(`ok ${l}`)
}

// --- 1. verdict kernel -----------------------------------------------------
assert.equal(
  classifyResponse({ choices: [{ message: { content: '7391 dark sign' } }] }, 200, { code: '7391' }).verdict,
  'READS',
)
ok('READS: transcribed code -> native')

assert.equal(
  classifyResponse(
    { error: { message: 'Invalid content type. image_url is only supported by certain models' } },
    400,
  ).verdict,
  'REFUSED',
)
ok('REFUSED: upstream "image_url is only supported by certain models"')

assert.equal(classifyResponse({ choices: [{ message: { content: 'NO_IMAGE' } }] }, 200).verdict, 'REFUSED')
ok('REFUSED: model replies NO_IMAGE')

// The old bug: 404 model_not_found / non-stream refusal was read as REFUSED and
// pushed perfectly good models into bridgeRoutes.
assert.equal(classifyResponse({ error: { message: '没有这个模型：glm-5.2-zx' } }, 404).verdict, 'SKIP')
assert.equal(
  classifyResponse(
    { error: { message: '{"code":11101,"msg":"Non-stream chat request is currently not supported"}' } },
    400,
  ).verdict,
  'SKIP',
)
ok('SKIP: model_not_found / non-stream limitation are NOT vision verdicts')

assert.equal(
  classifyResponse(
    { choices: [{ message: { content: '', reasoning_content: 'x'.repeat(500) }, finish_reason: 'length' }] },
    200,
  ).verdict,
  'QUOTA',
)
ok('QUOTA: empty content + finish=length + reasoning')

assert.equal(
  classifyResponse(
    { choices: [{ message: { content: 'a blue sign' }, finish_reason: 'stop' }] },
    200,
    { code: '7391' },
  ).verdict,
  'UNCLEAR',
)
ok('UNCLEAR: answered but did not transcribe the code')

// --- 2. test image is real and generated in-process ------------------------
{
  const code = randomCode()
  const png = genProbeImage(code, join(SANDBOX, 'probe.png'))
  const buf = readFileSync(png)
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
  assert.ok(buf.length > 2000, 'non-trivial PNG')
  ok(`probe image generated in-process (${buf.length} bytes, code ${code})`)
}

// --- 3. verdict -> table mapping ------------------------------------------
assert.equal(verdictToPush({ verdict: 'READS', provider: 'p', model: 'm' }).table, 'nativeGuards')
assert.equal(verdictToPush({ verdict: 'REFUSED', provider: 'p', model: 'm' }).table, 'bridges')
assert.equal(verdictToPush({ verdict: 'REFUSED', provider: 'p', model: 'm', needsPairing: true }), null)
assert.equal(verdictToPush({ verdict: 'SKIP', provider: 'p', model: 'm' }), null)
assert.equal(verdictToPush({ verdict: 'UNCLEAR', provider: 'p', model: 'm' }), null)
ok('verdictToPush: READS->nativeGuards, REFUSED->bridges, needsPairing/SKIP/UNCLEAR->null')

// --- 4. background pass with a fake host ----------------------------------
{
  const llm = {
    visionProbe: async ({ model }) =>
      model === 'sees'
        ? { verdict: 'READS', code: '1234' }
        : model === 'blind'
          ? { verdict: 'REFUSED', message: 'NO_IMAGE' }
          : { verdict: 'SKIP', message: 'model_not_found' },
    listModels: async (provider) => (provider === 'workbuddy' ? ['sees', 'blind', 'ghost'] : []),
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  }
  const logs = []
  const stats = await runProbePass({
    llm,
    config: { autoProbe: true, probe: { delayMs: 0 } },
    onLog: (m) => logs.push(m),
  })
  assert.equal(stats.probed, 2, 'two real verdicts stored, SKIP not persisted')
  assert.deepEqual(readdirSync(SANDBOX).filter((f) => f.endsWith('.png')), [], 'probe PNG deleted after use')
  const cache = loadCache()
  assert.equal(cache['workbuddy::sees'].verdict, 'READS')
  assert.equal(cache['workbuddy::blind'].verdict, 'REFUSED')
  assert.equal(cache['workbuddy::blind'].needsPairing, false)
  assert.equal(cache['workbuddy::ghost'], undefined, 'SKIP never persisted')
  ok('background pass: READS/REFUSED stored, SKIP dropped, needsPairing computed')

  // A second pass must not re-probe what is already classified.
  const again = await runProbePass({
    llm,
    config: { autoProbe: true, probe: { delayMs: 0 } },
    onLog: () => {},
  })
  assert.equal(again.probed, 0, 'classified models are skipped on the next pass')
  ok('second pass: nothing re-probed (idempotent across starts)')
}

// --- 4b. REFUSED without image intake is parked, not bridged --------------
{
  const llm = {
    visionProbe: async () => ({ verdict: 'REFUSED', message: 'NO_IMAGE' }),
    listModels: async (provider) => (provider === 'officeace' ? ['blind-unpaired'] : []),
    // No 'image' in inputModalities: the UI could never attach a picture here.
    resolveModelInfo: async () => ({ inputModalities: ['text'] }),
  }
  await runProbePass({ llm, config: {}, onLog: () => {} })
  const e = loadCache()['officeace::blind-unpaired']
  assert.equal(e.verdict, 'REFUSED')
  assert.equal(e.needsPairing, true, 'refused + no intake -> needsPairing')
  assert.equal(verdictToPush({ provider: 'officeace', model: 'blind-unpaired', ...e }), null, 'not bridged yet')
  ok('REFUSED without image intake -> needsPairing (never a dead bridge)')
}

// --- 5. restart: classification comes back from state/, no re-probe -------
{
  const handlers = {}
  const ctx = {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    logger: { info() {}, warn() {} },
    on: (n, f) => {
      handlers[n] = f
      return () => {}
    },
  }
  plugin.apply(ctx, { autoProbe: false, bridgeRoutes: [], nativeVisionModels: [] })
  assert.equal(plugin.isBridged('workbuddy', 'blind'), true, 'REFUSED -> bridged after restart')
  assert.equal(plugin.isBridged('workbuddy', 'sees'), false, 'READS -> never bridged')
  assert.equal(plugin.isNativeVision('workbuddy', 'sees'), true, 'READS -> native guard')
  assert.equal(plugin.isBridged('officeace', 'blind-unpaired'), false, 'unpaired REFUSED stays unbridged after restart')
  const st = plugin.probeStatus()
  assert.deepEqual(
    st.pendingPairing.map((e) => `${e.provider}/${e.model}`),
    ['officeace/blind-unpaired'],
    'needsPairing list surfaces in probeStatus()',
  )
  ok('restart: verdicts restored from state/probe-cache.json before any request')
}

// --- 6. a newly-classified native model is pulled out of bridges ----------
{
  saveCache({
    'workbuddy::blind': { verdict: 'REFUSED', probedAt: 1 },
    'workbuddy::both': { verdict: 'READS', probedAt: 1 },
  })
  const ctx = { llm: { resolveModelInfo: async () => ({}) }, logger: { info() {}, warn() {} }, on: () => () => {} }
  plugin.apply(ctx, {
    autoProbe: false,
    bridgeRoutes: [{ provider: 'workbuddy', model: 'both' }],
    nativeVisionModels: [],
  })
  assert.equal(plugin.isBridged('workbuddy', 'both'), false, 'native verdict wins over a manual bridge entry')
  ok('native verdict removes a conflicting bridge entry')
}

// --- 7. own-directory rule: no REACHABLE module leaves the plugin dir -----
// The guarantee is about code that actually runs. We walk the static import
// graph from index.js (and its dynamic import()) and scan only those files, so
// superseded helper files cannot mask a real escape.
{
  const seen = new Set()
  const queue = [join(PLUGIN, 'index.js')]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const txt = readFileSync(file, 'utf8')
    for (const m of txt.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      queue.push(resolve(dirname(file), spec))
    }
  }
  // Comments may TALK about the rule; only executed code may violate it.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const offenders = []
  for (const file of seen) {
    const code = strip(readFileSync(file, 'utf8'))
    if (/\.modlens|cordis\.patch\.yml|homedir\(\)/.test(code)) offenders.push(file.slice(PLUGIN.length + 1))
  }
  assert.deepEqual(offenders, [], `reachable files reaching outside the plugin dir: ${offenders.join(', ')}`)
  assert.ok(seen.size >= 4, 'index.js + 3 lib modules are reachable')
  assert.equal(
    [...seen].some((f) => f.endsWith('patchSync.mjs')),
    false,
    'patchSync.mjs (writes cordis.patch.yml) must not be reachable any more',
  )
  ok(`own-directory rule: ${seen.size} reachable modules, none read ~/.modlens/homedir()/cordis.patch.yml`)
}

// --- 8. config plumbing ---------------------------------------------------
{
  assert.equal(probeConfig({}).enabled, true)
  assert.equal(probeConfig({ autoProbe: false }).enabled, false)
  assert.equal(probeConfig({ probe: { enabled: false } }).enabled, false)
  assert.deepEqual(probeConfig({ probe: { providers: ['officeace'] } }).providers, ['officeace'])
  assert.equal(probeConfig({}).delayMs, 8000)
  ok('probeConfig: autoProbe/probe.enabled/providers/delayMs honoured')
}

rmSync(SANDBOX, { recursive: true, force: true })
assert.equal(existsSync(SANDBOX), false)
console.log(`\nALL AUTO-PROBE CHECKS PASSED (${passed} groups)`)
