import { execFileSync } from 'node:child_process';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
const bad = paths.filter(p => /(^|\/)node_modules\//.test(p) || p === 'off' || p.startsWith('.cache/'));
if (bad.length) throw new Error(`Tracked runtime artifacts: ${bad.join(', ')}`);
for (const path of ['package-lock.json', 'intel/package-lock.json']) if (!paths.includes(path)) throw new Error(`Missing lockfile: ${path}`);
console.log('Repository artifacts: OK');
