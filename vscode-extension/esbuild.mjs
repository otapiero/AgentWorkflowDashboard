import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const isTests = process.argv.includes('--tests');
const watch = process.argv.includes('--watch');
const here = fileURLToPath(new URL('.', import.meta.url));

const options = {
  absWorkingDir: here,
  entryPoints: [fileURLToPath(new URL(isTests ? './test/extension/extension.test.ts' : './src/extension.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  outfile: fileURLToPath(new URL(isTests ? './dist/test/extension.test.cjs' : './dist/extension.cjs', import.meta.url)),
  sourcemap: false,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('Watching extension sources...');
} else {
  await esbuild.build(options);
}
