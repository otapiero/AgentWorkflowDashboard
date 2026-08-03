import { stat } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/check-vsix-size.mjs <vsix>');
const bytes = (await stat(file)).size;
const limit = 500 * 1024;
if (bytes > limit) throw new Error(`VSIX ${bytes} bytes exceeds ${limit}`);
console.log(`VSIX ${bytes} bytes / ${limit} byte budget`);
