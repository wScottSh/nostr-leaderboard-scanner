// Bundles src/main.js (+ noble crypto) into dist/app.js and copies public/.
// `--serve` starts a local dev server with rebuild-on-request.
// SCANNER_RELAYS / SCANNER_INDEXERS (comma-separated ws URLs) replace the
// relay lists at build time, for local end-to-end runs only.
import * as esbuild from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

const serve = process.argv.includes('--serve');
rmSync('dist', { recursive: true, force: true });
cpSync('public', 'dist', { recursive: true });

const define = {};
for (const [env, name] of [['SCANNER_RELAYS', '__SCANNER_RELAYS__'], ['SCANNER_INDEXERS', '__SCANNER_INDEXERS__']]) {
  if (process.env[env]) define[name] = JSON.stringify(process.env[env].split(',').map((s) => s.trim()).filter(Boolean));
}

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !serve,
  sourcemap: serve,
  outfile: 'dist/app.js',
  define,
};

if (serve) {
  const ctx = await esbuild.context(options);
  const { port } = await ctx.serve({ servedir: 'dist', port: 8065 });
  console.log(`dev server: http://localhost:${port}/`);
} else {
  await esbuild.build(options);
  const overrides = Object.entries(define).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`built dist/${overrides ? ` with ${overrides}` : ''}`);
}
