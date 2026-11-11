// Offline selftest for the probe kernel (no network, no host).
// Run: node selftest-probe.mjs   (exit 0 = pass)
import assert from 'node:assert/strict'
import { classifyResponse } from './lib/probe.mjs'
import { verdictToPush } from './lib/probeRunner.mjs'

let passed = 0
const ok = (l) => { passed++; console.log(`ok ${l}`) }

// 1. REFUSED: real upstream 400 captured from deepseek-v4-flash-0731 probe.
;(() => {
  const j = { error: { message: '上游请求失败: Invalid content type. image_url is only supported by certain models', type: 'upstream_error' } }
  const r = classifyResponse(j, 400)
  assert.equal(r.verdict, 'REFUSED', `real 400 -> REFUSED, got ${r.verdict}`)
  ok('classifyResponse: real upstream 400 -> REFUSED')
})()

// 2. REFUSED: model explicitly says it cannot see (NO_IMAGE).
;(() => {
  const j = { choices: [{ message: { content: 'NO_IMAGE' }, finish_reason: 'stop' }] }
  assert.equal(classifyResponse(j, 200).verdict, 'REFUSED')
  ok('classifyResponse: NO_IMAGE content -> REFUSED')
})()

// 3. READS: 200 + content describing the code.
;(() => {
  const j = { choices: [{ message: { content: 'The big code reads 7391. A dark blue sign.' }, finish_reason: 'stop' }] }
  assert.equal(classifyResponse(j, 200).verdict, 'READS')
  ok('classifyResponse: code transcription -> READS')
})()

// 4. QUOTA: empty content + finish=length + reasoning>0 -> NOT a verdict.
;(() => {
  const j = { choices: [{ message: { content: '', reasoning_content: 'x'.repeat(500) }, finish_reason: 'length' }] }
  assert.equal(classifyResponse(j, 200).verdict, 'QUOTA')
  ok('classifyResponse: quota trap -> QUOTA (not a verdict)')
})()

// 5. UNCLEAR: 200, empty content, no reasoning, finish=stop.
;(() => {
  const j = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
  assert.equal(classifyResponse(j, 200).verdict, 'UNCLEAR')
  ok('classifyResponse: empty 200 -> UNCLEAR')
})()

// 6. verdictToPush routes READS->nativeGuards, REFUSED->bridges, else null.
;(() => {
  assert.deepEqual(verdictToPush({ provider: 'officeace', model: 'glm-5.3', verdict: 'READS' }),
    { table: 'nativeGuards', entry: { provider: 'officeace', model: 'glm-5.3' } })
  assert.deepEqual(verdictToPush({ provider: 'officeace', model: 'qwen3-32b', verdict: 'REFUSED' }),
    { table: 'bridges', entry: { provider: 'officeace', model: 'qwen3-32b' } })
  assert.equal(verdictToPush({ provider: 'officeace', model: 'x', verdict: 'QUOTA' }), null)
  assert.equal(verdictToPush({ provider: 'officeace', model: 'x', verdict: 'UNCLEAR' }), null)
  ok('verdictToPush: READS->native, REFUSED->bridges, QUOTA/UNCLEAR->null')
})()

// 7. verdictToPush is single-source (imported from probeRunner).
;(() => {
  assert.equal(typeof verdictToPush, 'function')
  ok('verdictToPush imported from probeRunner (single source)')
})()

console.log(`\nALL PROBE CHECKS PASSED (${passed} groups)`)
