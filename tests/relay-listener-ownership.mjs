import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRelayRuntime, relaySocketPath, resolveRelayInstall } from '../workflow/communication.mjs';

if (!resolveRelayInstall(process.env).root) {
  console.log('SKIP live listener ownership: installed relay unavailable');
} else {
  const root = mkdtempSync(join(tmpdir(), 'qq-relay-live-listener-'));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'relay'), { mode: 0o700 });
  const path = relaySocketPath(root);
  const connections = new Set();
  const server = createServer(socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); socket.end(); });
  try {
    server.listen(path); await once(server, 'listening');
    let spawns = 0;
    const result = await acquireRelayRuntime({ stateDir: root, spawnImpl: () => { spawns += 1; throw new Error('unexpected relay spawn'); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'refused');
    assert.equal(spawns, 0);
    assert.equal(existsSync(path), true, 'unhealthy live listener is never unlinked or replaced');
    console.log('PASS relay ownership: live non-relay listener is refused intact');
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
