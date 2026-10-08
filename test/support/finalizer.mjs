/**
 * Runs `node finalizer/run.mjs` the way the systemd timer does, with test
 * relays and calendars. FINALIZER_BIN=dist-finalizer/finalizer.mjs tests the
 * deployed bundle instead. -> { code, out }
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'finalizer', 'run.mjs');

export function runFinalizer({ relays, calendars, keyFile, args = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.env.FINALIZER_BIN ?? RUN, ...args], {
      env: { ...process.env, FINALIZER_RELAYS: relays.join(','), FINALIZER_CALENDARS: calendars.join(','), FINALIZER_KEY_FILE: keyFile },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}
