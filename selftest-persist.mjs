// RETIRED (1.2.0). Superseded by selftest-autoprobe.mjs, which covers the
// restart-persistence path against a throwaway state dir. This file used to seed
// and then DELETE the real state/probe-cache.json — running it now would wipe
// live verdicts, so it no longer does anything.
console.log('RETIRED: see selftest-autoprobe.mjs (group 5: restart persistence)')
process.exit(0)
