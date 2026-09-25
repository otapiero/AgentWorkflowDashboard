import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A per-file default install root, pointed at a temp directory.
 *
 * Suites isolate themselves with MC_HOME, which covers everything derived from
 * the project home — but not the root-scoped paths (scripts, the T3 pairing
 * credential and its token cache). A suite that set only MC_HOME therefore
 * reached the operator's real ~/.mission-control, and one did: a token-exchange
 * test wrote its fake 'tok-1' there, which then shadowed a real 30-day token.
 *
 * Setting a default here means forgetting MC_ROOT can no longer escape. A suite
 * that wants its own root still overrides this in beforeEach.
 */
const root = mkdtempSync(join(tmpdir(), 'mc-test-root-'));
process.env.MC_ROOT = root;
// Likewise T3's home: model discovery reads its provider caches, and the
// operator's real ones would make the built-in model lists untestable.
process.env.T3_HOME ??= join(root, 't3');

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});
