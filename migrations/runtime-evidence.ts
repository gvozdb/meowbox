#!/usr/bin/env node
import { main } from './hooks/runtime-evidence';

main().then((code) => {
  process.exitCode = code;
}).catch(() => {
  process.exitCode = 1;
});
