import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sync = require('../sync.js');

const CO2 = '耗材-CO\u2082';
const config = { workerUrl: 'http://127.0.0.1:8787/', pin: '1234' };

test('toSyncTx keeps the app category and entity key', () => {
  const payload = sync.toSyncTx({
    id: 'tx_1',
    date: '2026-10-03',
    type: 'expense',
    entity: 'beerwang',
    category: CO2,
    amount: '1200',
    hasInvoice: 1,
    note: '',
    updatedAt: '2026-10-26T00:00:00.000Z',
  });
  assert.equal(payload.category, CO2);
  assert.equal(payload.category.codePointAt(payload.category.length - 1), 0x2082);
  assert.equal(payload.entity, 'beerwang');
  assert.equal(payload.amount, 1200);
  assert.equal(payload.hasInvoice, true);
  assert.equal(payload.type, 'expense');
});

test('dedupeById keeps the newer copy of an id', () => {
  const rows = sync.dedupeById([
    { id: 'a', date: '2026-10-01', amount: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'a', date: '2026-10-02', amount: 2, updatedAt: '2026-10-02T00:00:00.000Z' },
    { id: 'b', date: '2026-10-03', amount: 3, updatedAt: '2026-10-03T00:00:00.000Z' },
    { date: '2026-10-04', amount: 4 },
  ]);
  assert.deepEqual(rows.map((row) => row.id).sort(), ['a', 'b']);
  assert.equal(rows.find((row) => row.id === 'a').amount, 2);
});

test('mergeTxs lets the newer updatedAt win, including deletes', () => {
  const local = [
    { id: 'keep-local', amount: 1, updatedAt: '2026-10-03T00:00:00.000Z', createdAt: 1 },
    { id: 'take-remote', amount: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'gone', amount: 5, deleted: true, updatedAt: '2026-10-02T00:00:00.000Z' },
  ];
  const remote = [
    { id: 'keep-local', amount: 9, updatedAt: '2026-10-02T00:00:00.000Z', deleted: false },
    { id: 'take-remote', amount: 8, updatedAt: '2026-10-04T00:00:00.000Z', deleted: false },
    { id: 'gone', deleted: true, updatedAt: '2026-10-05T00:00:00.000Z' },
    { id: 'from-notion', amount: 3, updatedAt: '2026-10-04T00:00:00.000Z', deleted: false },
  ];
  const merged = sync.mergeTxs(local, remote, []);
  const byId = Object.fromEntries(merged.map((row) => [row.id, row]));
  assert.equal(byId['keep-local'].amount, 1);
  assert.equal(byId['keep-local'].createdAt, 1);
  assert.equal(byId['take-remote'].amount, 8);
  assert.equal(byId.gone, undefined);
  assert.equal(byId['from-notion'].amount, 3);
});

test('a newer local tombstone is not resurrected by an older remote row', () => {
  const local = [{ id: 'tx_1', amount: 1, deleted: true, updatedAt: '2026-10-06T00:00:00.000Z' }];
  const remote = [{ id: 'tx_1', amount: 1, deleted: false, updatedAt: '2026-10-01T00:00:00.000Z' }];
  const outbox = [{ op: 'delete', id: 'tx_1', tx: local[0], attempts: 0 }];
  const merged = sync.mergeTxs(local, remote, outbox);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deleted, true);
});

test('enqueue replaces the previous operation for the same id', () => {
  const first = sync.enqueue([], { op: 'upsert', id: 'tx_1', tx: { id: 'tx_1', amount: 1 } });
  const second = sync.enqueue(first, { op: 'delete', id: 'tx_1', tx: { id: 'tx_1', deleted: true } });
  assert.equal(second.length, 1);
  assert.equal(second[0].op, 'delete');
});

test('failed pushes stay in the outbox and succeed on a later flush', async () => {
  let online = false;
  const fetchImpl = async () => {
    if (!online) throw new Error('offline');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const outbox = [{ op: 'upsert', id: 'tx_1', tx: { id: 'tx_1', date: '2026-10-01', type: 'income', entity: 'yapi', category: '其他收入', amount: 10 }, attempts: 0 }];
  const waiting = await sync.flushOutbox(config, outbox, fetchImpl);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].attempts, 1);
  assert.equal(waiting[0].id, 'tx_1');
  online = true;
  const done = await sync.flushOutbox(config, waiting, fetchImpl);
  assert.deepEqual(done, []);
});

test('an outbox item is dropped when Notion already has a newer row', () => {
  const remote = new Map([
    ['tx_1', { id: 'tx_1', amount: 9, updatedAt: '2026-10-08T00:00:00.000Z', deleted: false }],
  ]);
  const outbox = [{
    op: 'upsert',
    id: 'tx_1',
    tx: { id: 'tx_1', amount: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
    attempts: 1,
  }];
  assert.deepEqual(sync.reconcileOutbox(outbox, remote), []);
});

test('bulk upload posts ledger rows and is a no-op when sync is not configured', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, upserted: 1 }), { status: 200 });
  };
  const result = await sync.bulkUpload(config, [
    { id: 'tx_1', date: '2026-10-01', type: 'income', entity: 'yapi', category: CO2, amount: 5, deleted: false },
    { id: 'tx_2', deleted: true, date: '2026-10-01', type: 'expense', entity: 'yapi', category: '雜支', amount: 1 },
  ], fetchImpl);
  assert.equal(result.upserted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/ledger/bulk');
  assert.equal(calls[0].body.txs.length, 1);
  assert.equal(calls[0].body.txs[0].category, CO2);
  assert.equal(sync.isConfigured({ workerUrl: '', pin: '' }), false);
  const untouched = await sync.flushOutbox({ workerUrl: '', pin: '' }, [{ op: 'upsert', id: 'tx_1' }], fetchImpl);
  assert.equal(untouched.length, 1);
  assert.equal(calls.length, 1);
});
