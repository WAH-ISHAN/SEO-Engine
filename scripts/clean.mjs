import { rmSync } from 'node:fs';
// This fixed target is the generated build directory beside this script's parent.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
