import esbuild from 'esbuild';

const isTests = process.argv.includes('--tests');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: isTests ? ['test/extension/extension.test.ts'] : ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  outfile: isTests ? 'dist/test/extension.test.cjs' : 'dist/extension.cjs',
  sourcemap: false,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('Watching extension sources...');
} else {
  await esbuild.build(options);
}
