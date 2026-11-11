// Static WIRING gate — the checks that are safe to do without executing the
// plugin (full syntax validation still needs `node --check`, which this session
// could not run: the Bash executor was unavailable).
//
// It catches the class of bug that actually bit us: a module importing an export
// that no longer exists (e.g. `observedWorkbuddy` after it was removed), a
// relative import that points at a missing file, or a stray CommonJS `require(`
// inside an ES module. Run: node selftest-wiring.mjs
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(fileURLToPath(import.meta.url))
const FILES = ['index.js', 'lib/probe.mjs', 'lib/probeRunner.mjs', 'lib/verdictStore.mjs', 'lib/patchSync.mjs']

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Named + default exports of one module.
function exportsOf(src) {
  const code = stripComments(src)
  const names = new Set()
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/)
      const name = (bits[1] || bits[0] || '').trim()
      if (name) names.add(name)
    }
  }
  if (/export\s+default\b/.test(code)) names.add('default')
  return names
}

// Imported bindings per relative module: [{ spec, named: [...] }]
function importsOf(src) {
  const code = stripComments(src)
  const out = []
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const clause = m[1]
    const named = []
    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const first = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (first) named.push(first)
      }
    }
    out.push({ spec: m[2], named })
  }
  return out
}

let passed = 0
const ok = (l) => {
  passed++
  console.log(`ok ${l}`)
}

const exportsCache = new Map()
const load = (abs) => {
  if (!exportsCache.has(abs)) exportsCache.set(abs, exportsOf(readFileSync(abs, 'utf8')))
  return exportsCache.get(abs)
}

for (const rel of FILES) {
  const abs = join(PLUGIN, rel)
  assert.ok(existsSync(abs), `${rel}: missing`)
  const raw = readFileSync(abs, 'utf8')
  const code = stripComments(raw)

  // 1. no CommonJS in an ES module (the exact mistake made earlier in index.js)
  assert.equal(/(^|[^.\w$])require\s*\(/.test(code), false, `${rel}: require() inside an ES module`)

  // 2. every relative import resolves AND every named binding is really exported
  for (const { spec, named } of importsOf(raw)) {
    const target = resolve(dirname(abs), spec)
    assert.ok(existsSync(target), `${rel}: unresolved import ${spec}`)
    const available = load(target)
    for (const name of named) {
      assert.ok(
        available.has(name),
        `${rel}: imports { ${name} } from ${spec}, but that module does not export it`,
      )
    }
  }
  ok(`${rel}: ESM-only, imports resolve, imported names exist`)
}

// 3. the live entry point must not reach the retired cordis.patch.yml writer
{
  const reachable = new Set()
  const queue = [join(PLUGIN, 'index.js')]
  while (queue.length) {
    const file = queue.pop()
    if (reachable.has(file) || !existsSync(file)) continue
    reachable.add(file)
    for (const { spec } of importsOf(readFileSync(file, 'utf8'))) {
      queue.push(resolve(dirname(file), spec))
    }
  }
  for (const f of reachable) {
    const code = stripComments(readFileSync(f, 'utf8'))
    assert.equal(
      /\.modlens|cordis\.patch\.yml|homedir\(\)/.test(code),
      false,
      `${f}: reachable module touches a path outside the plugin directory`,
    )
  }
  ok(`own-directory rule: ${reachable.size} reachable modules, none leave the plugin dir`)
}

console.log(`\nALL WIRING CHECKS PASSED (${passed} groups)`)
console.log('NOTE: run `node --check` on index.js + lib/*.mjs once a shell is available.')
