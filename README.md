# dsh-modlens-vision-bridge

A standalone patch that makes modlens's vision bridge work **without editing
modlens itself**, and that **classifies new models by itself**.

## What it does

modlens treats any model whose resolved `inputModalities` includes `image` as a
native-vision model: it hides the `modlens_read_image` bridge tool and lets the
raw picture flow to the model. But to let the **UI** attach a picture at all,
the catalog must advertise `image` for that model (via the provider's
`imageModelIds`). For a text-only model (e.g. `hy3`, `hy4free`) that creates a
contradiction: advertise `image` → UI lets you attach, but modlens then skips
the OCR bridge and hands a raw picture to a blind model.

This plugin resolves it by wrapping the shared `ctx.llm.resolveModelInfo`
service (write-through, verified against the host proxy):

| Caller | args | Returned `inputModalities` | Effect |
| --- | --- | --- | --- |
| admission gate, catalog build, ACP advertise | 2 | unchanged (`['text','image']`) | UI still offers the picture button; admission stays green |
| modlens nativeVisionGate + autoRead, host image projection | 3 | **stripped** | route reads as text-only → bridge tool stays visible, autoRead OCRs the image |

Non-listed routes pass through untouched; `nativeVisionModels` are vetoed and
never OCR-degraded.

## Auto-probe (new in 1.2.0)

At every DSH start the plugin, after installing the wrapper, schedules **one
background pass** (`probe.delayMs`, default 8 s, total budget 180 s):

1. `ctx.llm.listModels(provider)` for `probe.providers`
   (default `workbuddy`, `workbuddy-global`, `officeace`);
2. every model that is not in `bridgeRoutes` / `nativeVisionModels` **and** not
   in `state/probe-cache.json` gets a random-number PNG (generated in-process,
   no python, no font files);
3. the verdict decides the table:

| Verdict | Meaning | Stored as |
| --- | --- | --- |
| `READS` | the code was transcribed | `nativeVisionModels` (never OCR-degraded) |
| `REFUSED` | model says it cannot see an image | `bridgeRoutes` — **only if** the route already advertises `image`, else `needsPairing` |
| `SKIP` | endpoint problem (404 model_not_found, "Non-stream … not supported", network) | not persisted, retried next start |
| `QUOTA` / `UNCLEAR` | empty answer / code not transcribed | not persisted, retried next start |

4. verdicts go into the **live** tables immediately (no restart) and into
   `state/probe-cache.json` (atomic tmp+rename).

At the next start `state/probe-cache.json` is folded back into the tables
**synchronously inside `apply()`**, before the wrapper is installed — so the
classification is already in force for the first `resolveModelInfo` call and
nothing has to be re-probed.

`needsPairing` exists because a bridge without image intake is a dead route:
the model would be OCR-bridged but the UI could never hand it a picture. The
plugin never edits your patch layer, it just logs
`add it to that provider's imageModelIds to enable the bridge`.

### Transport

* `ctx.llm.visionProbe({ provider, model, imageDataUrl, code })` when the host
  exposes it (dsh-connect-workbuddy does) — no port, no HTTP, no credentials;
* otherwise a direct `POST {baseUrl}/chat/completions` using credentials from
  **this plugin's own files**: `config.probe.credentials[]` or
  `state/probe-credentials.json` (`{"<provider>":{"baseUrl":"…","apiKey":"…"}}`).
  That file is optional and never shipped; create it by hand only for providers
  the host cannot probe. If neither transport exists for a provider, the pass
  logs one line naming the provider and how many models stayed unclassified —
  it does not guess.

### Config

```yaml
- id: modlens-vision-bridge
  name: '@local/dsh-modlens-vision-bridge'
  config:
    autoProbe: true          # false = never probe
    probe:
      enabled: true
      delayMs: 8000          # wait this long after apply() before probing
      providers: [workbuddy, workbuddy-global, officeace]
      # credentials: [{ provider: officeace, baseUrl: …, apiKey: … }]
    bridgeRoutes: []         # manual entries always win over nothing; probe only adds
    nativeVisionModels: []   # a READS verdict also removes a conflicting bridge entry
```

## Self-contained (hard rule)

The plugin reads and writes **only files inside its own directory**
(`state/probe-cache.json`, optional `state/probe-credentials.json`). It does not
read `~/.modlens/config.json` and does not rewrite the profile's
`cordis.patch.yml`. `selftest-autoprobe.mjs` group 7 enforces this by scanning
every module for `~/.modlens`, `homedir()` and `cordis.patch.yml`.

## Ordering requirement

This plugin **must load before `@liustack/modlens`** in `dsh.profile.bundles`.
modlens runs an apply-time scan over live agents that probes
`resolveModelInfo` and caches the result permanently — if the wrapper (and the
restored verdict tables) are not in place yet, that cache holds the wrong value
and the bridge tool disappears.

## Known regressions (by design)

The host's own `read_image` tool and the MCP image-admission precheck use an
**unprotected** `inputModalities === void 0 || !includes('image')` gate, so on
a bridged text-only model they refuse. They would otherwise hand a raw picture
to a blind model; the correct tool there is `modlens_read_image`. The main chat
flow (attach a photo → modlens OCR) is unaffected.

## Tests

```bash
node selftest-syntax.mjs      # wiring gate: ESM-only, imports resolve and export what is imported
node selftest-autoprobe.mjs   # kernel, PNG, verdict routing, restart, own-dir rule
node selftest-wrapper.mjs     # 2-arg vs 3-arg strip, native veto, idempotence, dispose
```

Both run offline against a throwaway `VISION_BRIDGE_STATE_DIR`, so they never
read or write the real `state/probe-cache.json`.

`selftest.mjs`, `selftest-integration.mjs`, `selftest-patch.mjs`,
`selftest-patch-e2e.mjs`, `selftest-persist.mjs`, `selftest-workbuddy.mjs` are
pre-1.2 files (patch.yml syncing, python image generation, `observedWorkbuddy`).
They are now tombstones that print a RETIRED line and exit 0; they are not part
of the verification story.

## Files

- `index.js` — wrapper + decision tables + probe scheduling + `probeStatus()`.
- `lib/probe.mjs` — PNG generator + verdict kernel + HTTP/SSE transport.
- `lib/probeRunner.mjs` — one background pass over all providers.
- `lib/verdictStore.mjs` — `state/probe-cache.json` I/O + cache→tables mapping.
- `lib/patchSync.mjs` — retired tombstone (used to rewrite cordis.patch.yml).
- `cordis.patch.yml` — default bridge policy shipped with the plugin.
