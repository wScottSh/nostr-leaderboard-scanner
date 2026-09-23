// Bundles src/main.js (+ noble crypto) into dist/app.js and copies public/.
// `--serve` starts a local dev server with rebuild-on-request.
import * as esbuild from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

const serve = process.argv.includes('--serve');
rmSync('dist', { recursive: true, force: true });
cpSync('public', 'dist', { recursive: true });

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !serve,
  sourcemap: serve,
  outfile: 'dist/app.js',
};

if (serve) {
  const ctx = await esbuild.context(options);
  const { port } = await ctx.serve({ servedir: 'dist', port: 8065 });
  console.log(`dev server: http://localhost:${port}/`);
} else {
  await esbuild.build(options);
  console.log('built dist/');
}
