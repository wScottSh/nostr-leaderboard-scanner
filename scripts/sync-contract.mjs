// Regenerates src/generated/transport_contract.js from an sm64-nostr checkout
// (default ../sm64-nostr; override with SM64_NOSTR=<path>) using that repo's
// own generator, so the wire format is never hand-copied. Unlike sm64-nostr's
// reader/, the output is committed: this repo builds on CI without the ROM repo.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(process.env.SM64_NOSTR || '../sm64-nostr');
const gen = path.join(repo, 'tools', 'gen_transport_contract_js.py');
const out = path.resolve('src/generated/transport_contract.js');

for (const py of ['python3', 'python']) {
  const r = spawnSync(py, [gen, '--out', out], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(`synced ${out} from ${repo}`);
    process.exit(0);
  }
}
console.error('sync-contract: generator failed (need python3 and an sm64-nostr checkout)');
process.exit(1);
