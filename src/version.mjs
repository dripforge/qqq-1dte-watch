import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_FILE = fileURLToPath(new URL('../package.json', import.meta.url));
export const VERSION = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(VERSION)) throw new Error('Invalid package version');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(VERSION);
