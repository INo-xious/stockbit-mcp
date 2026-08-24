## What this changes, and why

<!-- What was wrong before. The subject line says what; this says why. -->

## Evidence

<!-- If this touches a tool that reads Stockbit, say which rung of the ladder the
     change sits on: Observed (a live response was seen), Read-back (a write
     verified by re-reading), or Projected (field names from the web bundle,
     never seen live). "It returned 200" is not evidence that the field you read
     is the field you thought it was. -->

## Checklist

- [ ] `npm run typecheck && npm test && npm run build && npm run smoke && npm run check:pack` all pass
- [ ] `npm run docs:tools` re-run and `docs/TOOLS.md` committed, if a tool changed
- [ ] Any new **write** tool is listed in `WRITES` in `test/tools.test.ts`
- [ ] Any new **non-GET** route has an ADR in `docs/adr/`, landed with or before this
- [ ] No fixture contains a real account number, name or watchlist
- [ ] A `CHANGELOG.md` entry under `## [Unreleased]`
- [ ] The evidence words are used as `CONTEXT.md` defines them
- [ ] No AI co-author trailer in the commits
