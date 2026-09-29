import { cpSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../dist/test/', import.meta.url), { recursive: true });
cpSync(new URL('../test/fixtures/', import.meta.url), new URL('../dist/test/fixtures/', import.meta.url), { recursive: true });
