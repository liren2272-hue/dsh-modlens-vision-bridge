// dsh-modlens-vision-bridge — vision capability probe kernel.
// ---------------------------------------------------------------------------
// Verdict semantics follow ~/.modlens/vision-routing/probe-vision.mjs: the only
// trustworthy answer to "can this model see a picture" is a real PNG sent to the
// live chat/completions endpoint with the random code asked back.
//
//   READS   -> 200 + the code was transcribed            -> nativeVisionModels
//   REFUSED -> model says it cannot see (NO_IMAGE / "image_url is only
//              supported by certain models")             -> bridgeRoutes
//   QUOTA   -> empty content + finish=length + reasoning  -> NOT a verdict
//   UNCLEAR -> answered, but did not transcribe the code  -> NOT a verdict
//   SKIP    -> transport/infrastructure problem (404 model_not_found,
//              "Non-stream chat request is not supported", network, 5xx).
//              NOT a verdict: this used to be mis-read as REFUSED and pushed
//              perfectly good models into bridgeRoutes. Never classify on it.
//
// Self-contained: the probe PNG is encoded in-process (node:zlib only, no
// python, no external font, nothing read from outside this plugin directory).

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const MAX_TOKENS = 3000 // >=2000 to dodge the QUOTA trap (reasoning burns tokens)

const SKIP_RE =
  /model_not_found|没有这个模型|no such model|unknown model|does not exist|Non-stream chat request is currently not supported|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network:/i
const REFUSED_RE =
  /NO_IMAGE|does not support (image|vision|multimodal)|cannot (see|view|read|process) (an? )?(image|picture)|not multimodal|invalid content type|only supported by certain models|image_url is not supported|no image provided/i

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// --- verdict core (works on any OpenAI-shaped chat.completions JSON) --------
export function classifyResponse(j, status, { code } = {}) {
  const ch = j?.choices?.[0] || {}
  const msg = ch.message || {}
  const content = String(msg.content ?? '')
  const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '')
  const finish = ch.finish_reason || ''
  const err = String(j?.error?.message ?? j?.error ?? '')
  const text = `${content} ${err}`

  if (status === 0) return { verdict: 'SKIP', why: `transport: ${err || 'no response'}` }
  if (SKIP_RE.test(text) || status === 404) {
    return { verdict: 'SKIP', why: `endpoint/model unusable (HTTP ${status}): ${text.trim().slice(0, 160)}` }
  }
  if (REFUSED_RE.test(text)) {
    return { verdict: 'REFUSED', why: `model says it cannot see: ${text.trim().slice(0, 140)}` }
  }
  if (!j?.choices || status >= 400) {
    return { verdict: 'SKIP', why: `HTTP ${status} without an explicit vision refusal: ${text.trim().slice(0, 140)}` }
  }
  if (!content.trim() && finish === 'length' && reasoning.length > 0) {
    return {
      verdict: 'QUOTA',
      why: `empty content, finish=length, reasoning=${reasoning.length} chars -> raise max_tokens, NOT a vision verdict`,
    }
  }
  if (!content.trim()) return { verdict: 'UNCLEAR', why: `HTTP ${status}, empty content, finish=${finish}` }
  if (code && !norm(content).includes(norm(code))) {
    return { verdict: 'UNCLEAR', why: `answered but did not transcribe ${code}: ${content.slice(0, 120)}` }
  }
  return { verdict: 'READS', why: code ? `transcribed ${code}` : `content(${content.length}): ${content.slice(0, 120)}` }
}

// --- direct HTTP probe (self transport, credentials from OUR config only) ---
export async function probeOne(base, key, imageDataUrl, model, opts = {}) {
  const { code, fetchImpl = fetch, stream = false } = opts
  const prompt =
    'Look at this image. Transcribe the large number shown, then describe the scene in one short phrase. ' +
    'If you cannot see any image, reply exactly: NO_IMAGE.'
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  }
  if (stream) body.stream = true
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
  let status = 0
  let payload = {}
  try {
    const r = await fetchImpl(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    status = r.status
    if (stream && r.ok && typeof r.text === 'function') {
      const raw = await r.text()
      payload = parseSse(raw)
    } else {
      payload = await r.json().catch(() => ({}))
    }
  } catch (e) {
    return { model, verdict: 'SKIP', status: 0, why: `network: ${e.message}` }
  }
  const { verdict, why } = classifyResponse(payload, status, { code })
  return { model, verdict, status, why }
}

// Minimal SSE reader: fold delta.content / delta.reasoning_content.
function parseSse(raw) {
  let content = ''
  let reasoning = ''
  let finish = ''
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let j
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    const ch = j?.choices?.[0] || {}
    const d = ch.delta || ch.message || {}
    if (d.content) content += d.content
    if (d.reasoning_content) reasoning += d.reasoning_content
    if (ch.finish_reason) finish = ch.finish_reason
  }
  return { choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finish }] }
}

export async function listModels(base, key, fetchImpl = fetch) {
  const r = await fetchImpl(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!r.ok) return []
  const j = await r.json().catch(() => ({}))
  return (j.data || []).map((m) => m.id).filter(Boolean)
}

// --- test image (in-process PNG, no external tool) --------------------------
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

export function randomCode(len = 6) {
  let s = ''
  for (let i = 0; i < len; i++) s += String(Math.floor(Math.random() * 10))
  return s
}

function crcTable() {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
}
const CRC = crcTable()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePng(W, H, rgb) {
  const stride = W * 3 + 1
  const raw = Buffer.alloc(stride * H)
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0
    rgb.copy(raw, y * stride + 1, y * W * 3, (y + 1) * W * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// Render the code as a big, high-contrast PNG. Returns the written path.
export function genProbeImage(code, outPath, { scale = 14 } = {}) {
  const digits = String(code).split('')
  const gw = 5 * scale
  const gh = 7 * scale
  const gap = 3 * scale
  const padX = 6 * scale
  const padY = 6 * scale
  const W = padX * 2 + digits.length * gw + (digits.length - 1) * gap
  const H = padY * 2 + gh
  const bg = [18, 52, 86]
  const fg = [255, 235, 120]
  const rgb = Buffer.alloc(W * H * 3)
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 3
    rgb[i] = r
    rgb[i + 1] = g
    rgb[i + 2] = b
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, bg)
  const border = Math.max(2, Math.round(scale / 3))
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (x < border || y < border || x >= W - border || y >= H - border) set(x, y, fg)

  digits.forEach((ch, n) => {
    const glyph = GLYPHS[ch]
    if (!glyph) return
    const ox = padX + n * (gw + gap)
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (glyph[ry][rx] !== '1') continue
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) set(ox + rx * scale + dx, padY + ry * scale + dy, fg)
      }
    }
  })
  writeFileSync(outPath, encodePng(W, H, rgb))
  return outPath
}
