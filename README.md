# dsh-modlens-vision-bridge

A standalone patch that makes modlens's vision bridge work **without editing
modlens itself**.

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

## Ordering requirement

This plugin **must load before `@liustack/modlens`** in `dsh.profile.bundles`.
modlens runs an apply-time scan over live agents that probes
`resolveModelInfo` and caches the result permanently — if the wrapper is not
installed yet, that cache holds the wrong (native-vision) value and the bridge
tool disappears.

## Known regressions (by design)

The host's own `read_image` tool and the MCP image-admission precheck use an
**unprotected** `inputModalities === void 0 || !includes('image')` gate, so on
a bridged text-only model they refuse. They would otherwise hand a raw picture
to a blind model; the correct tool there is `modlens_read_image`. The main chat
flow (attach a photo → modlens OCR) is unaffected.

## Files

- `index.js` — the wrapper + decision tables (no external file dependencies).
- `cordis.patch.yml` — self-contained bridge policy (migrated out of modlens).
