// dsh-modlens-vision-bridge — RETIRED module (kept as a tombstone).
// ---------------------------------------------------------------------------
// Up to 1.1.x this file rewrote the desktop profile's cordis.patch.yml with the
// probe verdicts. That is gone: the plugin may only touch files inside its own
// directory, so verdicts now live in <plugin>/state/probe-cache.json and are
// restored from there at apply() time (see lib/verdictStore.mjs).
//
// Nothing imports this module any more (selftest-autoprobe.mjs asserts it is
// not reachable from index.js). It stays only so an old copy of the plugin is
// not silently resurrected, and it refuses to write anything.

export function defaultPatchPath() {
  return null
}

export function listsFromCache() {
  return { bridgeRoutes: [], nativeVisionModels: [] }
}

export function syncPatchFromCache() {
  return 'error:disabled — verdicts persist in <plugin>/state/probe-cache.json (own-directory rule)'
}
