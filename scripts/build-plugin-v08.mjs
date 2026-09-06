#!/usr/bin/env node
// Generate v0.8 runtime entries without duplicating the plugin's UI or host code.
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../paseo-plugin', import.meta.url));
const target = process.argv[2] && resolve(process.argv[2]);
if (!target || target === source) throw new Error('Provide a separate output directory for the v0.8 adapter');
if (existsSync(target)) throw new Error('Output already exists; use a fresh directory');
mkdirSync(join(target, 'node_modules'), { recursive: true });
mkdirSync(join(target, 'server'));
writeFileSync(join(target, 'paseo-plugin.json'), '{"id":"architect"}\n');
writeFileSync(join(target, 'package.json'), '{"name":"architect-v08-adapter","private":true}\n');
symlinkSync(source, join(target, 'node_modules', 'architect'), 'dir');
writeFileSync(join(target, 'index.client.tsx'), 'export { registerClient as default } from "architect/architect.client";\n');
writeFileSync(join(target, 'server', 'root.ts'), `process.env.ARCHITECT_PLUGIN_ROOT = ${JSON.stringify(source)};\n`);
writeFileSync(join(target, 'index.server.ts'), `import "./server/root";
import { handleStart, handleTicket, handleChildren } from "architect/architect.server";
import { startArchitectRpc, ticketSnapshotRpc, childrenRpc } from "architect/architect.shared";
export default function contribute(server) {
  server.handle(startArchitectRpc, handleStart);
  server.handle(ticketSnapshotRpc, handleTicket);
  server.handle(childrenRpc, handleChildren);
  return () => {};
}
`);
console.log(target);
