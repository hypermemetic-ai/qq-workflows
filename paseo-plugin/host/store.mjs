import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { STATE_DIR } from './config.mjs';
const encode = value => JSON.stringify(value, (key, item) => key === 'donePromise' ? undefined : item);

// Every externally observable acknowledgement is committed with FULL durability.
export function createStore(path = join(STATE_DIR, 'state.sqlite')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS wakes (id TEXT PRIMARY KEY, parent TEXT NOT NULL, text TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, operation TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS active_attempt ON attempts(operation) WHERE state='active';`);
  const get = (kind, id) => {
    const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.value) : null;
  };
  const put = (kind, id, value) => db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, encode(value));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    get, put, transaction,
    list: kind => db.prepare('SELECT id,value FROM records WHERE kind=?').all(kind).map(row => [row.id, JSON.parse(row.value)]),
    delete: (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id),
    receive(job, input) {
      return transaction(() => {
        const prior = get('receipt', job.id);
        if (prior) return prior;
        const receipt = { ok: true, accepted: true, receiptId: randomUUID(), jobId: job.id };
        put('receipt', job.id, receipt);
        put('completion', job.id, input);
        put('job', job.id, { ...job, phase: 'completion_received' });
        return receipt;
      });
    },
    wake(parent, text, id = randomUUID()) {
      db.prepare('INSERT OR IGNORE INTO wakes(id,parent,text,created) VALUES(?,?,?,?)').run(id, parent, text, Date.now());
      return id;
    },
    wakes: parent => db.prepare('SELECT id,text FROM wakes WHERE parent=? AND acknowledged=0 ORDER BY created,rowid').all(parent).map(row => ({ ...row })),
    ack(parent, ids) { transaction(() => { for (const id of ids) db.prepare('UPDATE wakes SET acknowledged=1 WHERE parent=? AND id=?').run(parent, id); }); },
    begin(operation, value = {}) {
      const id = randomUUID();
      db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(id, operation, 'active', encode(value));
      return id;
    },
    finish(id, value) {
      const prior = db.prepare("SELECT value FROM attempts WHERE id=? AND state='active'").get(id);
      if (!prior) throw new Error('stale attempt result');
      const result = db.prepare("UPDATE attempts SET state='complete',value=? WHERE id=? AND state='active'").run(encode({ ...JSON.parse(prior.value), outcome: value }), id);
      if (!result.changes) throw new Error('stale attempt result');
    },
    active: () => db.prepare("SELECT * FROM attempts WHERE state='active'").all().map(row => ({ ...row, value: JSON.parse(row.value) })),
    close: () => db.close(),
  };
}

export function persistentMap(store, kind) {
  const map = new Map(store.list(kind));
  const set = map.set.bind(map), del = map.delete.bind(map);
  map.set = (id, value) => { store.put(kind, id, value); return set(id, value); };
  map.delete = id => { store.delete(kind, id); return del(id); };
  return map;
}
