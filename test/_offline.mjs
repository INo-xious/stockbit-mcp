/**
 * The switch that makes the whole suite offline, set before any test module loads.
 *
 * Loaded by `npm test` through `--import`, so it runs ahead of every test file and every module
 * they import. It is not named `*.test.ts`, so the runner's glob does not pick it up as a test.
 *
 * ## Why this exists rather than a line in each test file
 *
 * `status` asks npm whether a newer release exists, and the `status` TOOL asks for that check by
 * name. Two rounds of review found two different ways that reached the network from `npm test`:
 * first the tests that SPAWN a bin (a child does not inherit a stubbed `fetch`), then
 * `test/system.test.ts`, which spawns nothing and simply calls the tool in-process. Both were
 * fixed where they were found, and the second one proved the approach wrong: a per-call-site fix
 * is a list of the places someone has already thought of, and the failure mode is the place nobody
 * thought of.
 *
 * So the guarantee lives HERE, once, ahead of everything. A new test file cannot forget it, because
 * it never had to remember it. Children spawned with `...process.env` inherit it for free; the two
 * spawners that build an explicit env allowlist set it themselves, and `test/updatecheck.test.ts`
 * asserts they still do.
 *
 * `??=`, not `=`: a developer running one file with the switch already set to something else is
 * making a deliberate choice, and this must not overrule it.
 */
process.env.STOCKBIT_NO_UPDATE_CHECK ??= "1";
