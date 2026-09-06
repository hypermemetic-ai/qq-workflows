#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { architectMeasurements } from '../paseo-plugin/host/measurements.mjs';

const { values } = parseArgs({ options: {
  home: { type: 'string', default: process.env.PASEO_HOME || join(homedir(), '.paseo') },
  cwd: { type: 'string' }, source: { type: 'string' },
} });
if (values.source && !['operator', 'wake'].includes(values.source)) throw new Error('--source must be operator or wake');
const db = new DatabaseSync(join(resolve(values.home), 'architect', 'state.sqlite'), { readOnly: true });
try {
  db.exec('BEGIN');
  console.log(JSON.stringify(architectMeasurements(db, { cwd: values.cwd && resolve(values.cwd), source: values.source }), null, 2));
} finally { db.close(); }
