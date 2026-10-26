/* Ledger sync client. Classic script in the browser, CommonJS for node:test.
   PIN and the worker URL stay in localStorage; this file has no secrets. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LedgerSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var OUTBOX_KEY = 'sync:outbox';
  var URL_KEY = 'sync:workerUrl';
  var PIN_KEY = 'sync:pin';
  var BULK_CHUNK = 25;

  function tsOf(tx) {
    if (!tx) return 0;
    if (tx.updatedAt) {
      var parsed = Date.parse(tx.updatedAt);
      if (!isNaN(parsed)) return parsed;
    }
    if (typeof tx.createdAt === 'number' && !isNaN(tx.createdAt)) return tx.createdAt;
    return 0;
  }

  function normalizeBase(url) {
    var trimmed = String(url || '').trim();
    if (!trimmed) return '';
    try {
      var parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      var path = parsed.pathname.replace(/\/+$/, '');
      return parsed.origin + path;
    } catch (e) {
      return '';
    }
  }

  function isConfigured(config) {
    return !!(config && normalizeBase(config.workerUrl) && typeof config.pin === 'string' && config.pin.length > 0);
  }

  function toSyncTx(tx) {
    var out = {
      id: String(tx.id),
      date: tx.date,
      type: tx.type === 'expense' ? 'expense' : 'income',
      entity: tx.entity,
      category: tx.category,
      amount: Number(tx.amount),
      hasInvoice: !!tx.hasInvoice,
      note: tx.note || '',
      deleted: !!tx.deleted
    };
    if (tx.updatedAt) out.updatedAt = tx.updatedAt;
    if (typeof tx.createdAt === 'number') out.createdAt = tx.createdAt;
    return out;
  }

  function overlay(base, extra, forced) {
    var out = {};
    var key;
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] !== undefined) out[key] = extra[key];
    }
    if (forced) {
      for (key in forced) if (Object.prototype.hasOwnProperty.call(forced, key)) out[key] = forced[key];
    }
    return out;
  }

  function pickNewer(a, b) {
    if (!a) return b;
    if (!b) return a;
    return tsOf(b) >= tsOf(a) ? b : a;
  }

  function dedupeById(txs) {
    var map = new Map();
    (txs || []).forEach(function (tx) {
      if (!tx || !tx.id) return;
      var prev = map.get(tx.id);
      map.set(tx.id, prev ? pickNewer(prev, tx) : tx);
    });
    return Array.from(map.values());
  }

  function mergeTxs(local, remote, outbox) {
    var pending = {};
    (outbox || []).forEach(function (item) {
      if (item && item.id) pending[item.id] = item.op;
    });
    var map = new Map();
    (local || []).forEach(function (tx) {
      if (tx && tx.id) map.set(tx.id, overlay(tx, {}));
    });
    (remote || []).forEach(function (incoming) {
      if (!incoming || !incoming.id) return;
      var current = map.get(incoming.id);
      var op = pending[incoming.id];
      if (op === 'delete' && current && tsOf(current) >= tsOf(incoming)) {
        map.set(incoming.id, overlay(current, {}, { deleted: true }));
        return;
      }
      if (op === 'upsert' && current && tsOf(current) >= tsOf(incoming)) return;
      if (!current) {
        if (!incoming.deleted) map.set(incoming.id, overlay(incoming, {}));
        return;
      }
      if (tsOf(incoming) >= tsOf(current)) {
        if (incoming.deleted) map.delete(incoming.id);
        else map.set(incoming.id, overlay(current, incoming, { deleted: false }));
      }
    });
    return Array.from(map.values());
  }

  function enqueue(outbox, item) {
    var next = (outbox || []).filter(function (existing) {
      return existing && existing.id !== item.id;
    });
    next.push({
      op: item.op,
      id: item.id,
      tx: item.tx,
      attempts: item.attempts || 0,
      updatedAt: item.updatedAt || (item.tx && item.tx.updatedAt) || null
    });
    return next;
  }

  function reconcileOutbox(outbox, remoteById) {
    var remote = remoteById instanceof Map ? remoteById : new Map(remoteById || []);
    return (outbox || []).filter(function (item) {
      if (!item || !item.id) return false;
      var remoteTx = remote.get(item.id);
      if (!remoteTx) return true;
      var localTs = tsOf(item.tx) || tsOf({ updatedAt: item.updatedAt });
      if (item.op === 'delete' && remoteTx.deleted) return false;
      return localTs >= tsOf(remoteTx);
    });
  }

  function endpoint(config, path) {
    return normalizeBase(config.workerUrl) + path;
  }

  async function request(config, path, options, fetchImpl) {
    var fetchFn = fetchImpl || globalThis.fetch;
    return fetchFn(endpoint(config, path), {
      method: options.method,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Pin': config.pin
      },
      body: options.body
    });
  }

  async function pushUpsert(config, tx, fetchImpl) {
    var res = await request(config, '/ledger/txs/' + encodeURIComponent(tx.id), {
      method: 'PUT',
      body: JSON.stringify(toSyncTx(tx))
    }, fetchImpl);
    if (!res.ok) throw failed(res);
    return res.json().catch(function () { return { ok: true }; });
  }

  function failed(res) {
    var error = new Error('sync failed');
    error.status = res.status;
    return error;
  }

  async function pushDelete(config, id, fetchImpl) {
    var res = await request(config, '/ledger/txs/' + encodeURIComponent(id), { method: 'DELETE' }, fetchImpl);
    if (res.status === 404) return { ok: true, deleted: true };
    if (!res.ok) throw failed(res);
    return res.json().catch(function () { return { ok: true }; });
  }

  async function pullTxs(config, fetchImpl) {
    if (!isConfigured(config)) throw new Error('sync not configured');
    var res = await request(config, '/ledger/txs', { method: 'GET' }, fetchImpl);
    if (!res.ok) throw failed(res);
    var data = await res.json();
    if (!data || !Array.isArray(data.txs)) throw new Error('bad payload');
    return data.txs;
  }

  async function bulkUpload(config, txs, fetchImpl) {
    if (!isConfigured(config)) throw new Error('sync not configured');
    var payload = (txs || []).filter(function (tx) { return tx && tx.id && !tx.deleted; }).map(toSyncTx);
    var upserted = 0;
    var i;
    for (i = 0; i < payload.length; i += BULK_CHUNK) {
      var slice = payload.slice(i, i + BULK_CHUNK);
      var res = await request(config, '/ledger/bulk', {
        method: 'POST',
        body: JSON.stringify({ txs: slice })
      }, fetchImpl);
      if (!res.ok) throw failed(res);
      var data = await res.json().catch(function () { return {}; });
      upserted += typeof data.upserted === 'number' ? data.upserted : slice.length;
    }
    return { ok: true, upserted: upserted };
  }

  async function flushOutbox(config, outbox, fetchImpl) {
    if (!isConfigured(config)) return (outbox || []).slice();
    var remaining = [];
    var i;
    for (i = 0; i < (outbox || []).length; i++) {
      var item = outbox[i];
      try {
        if (!item || !item.id) continue;
        if (item.op === 'delete') await pushDelete(config, item.id, fetchImpl);
        else await pushUpsert(config, item.tx || { id: item.id }, fetchImpl);
      } catch (e) {
        remaining.push({
          op: item.op,
          id: item.id,
          tx: item.tx,
          attempts: (item.attempts || 0) + 1,
          updatedAt: item.updatedAt || null
        });
      }
    }
    return remaining;
  }

  return {
    OUTBOX_KEY: OUTBOX_KEY,
    URL_KEY: URL_KEY,
    PIN_KEY: PIN_KEY,
    normalizeBase: normalizeBase,
    isConfigured: isConfigured,
    toSyncTx: toSyncTx,
    dedupeById: dedupeById,
    mergeTxs: mergeTxs,
    pickNewer: pickNewer,
    enqueue: enqueue,
    reconcileOutbox: reconcileOutbox,
    pullTxs: pullTxs,
    pushUpsert: pushUpsert,
    pushDelete: pushDelete,
    bulkUpload: bulkUpload,
    flushOutbox: flushOutbox
  };
});
