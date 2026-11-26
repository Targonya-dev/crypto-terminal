/* Crypto Terminal Cloud v1.0 client adapter.
 * Same-origin Pages proxy only. Never place GitHub credentials in this file.
 */
(function (root) {
  'use strict';
  const API = '/api';
  const PERMISSIONS = ['view', 'history', 'trade', 'edit', 'funds'];
  const COLLECTION_KEYS = [
    'ct_watch', 'ct_watch_groups',
    'ct_options_portfolio_v1', 'ct_options_portfolio_v1_closed', 'ct_options_portfolio_v1_updated',
    'ct_option_strategies_v1', 'ct_analytics_history'
  ];
  const jsonClone = value => JSON.parse(JSON.stringify(value));
  const epochMs = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NaN;
  };
  // Keep an operation key across transport failures so a retry after an
  // ambiguous timeout cannot debit a wallet or append a trade twice.
  const pendingOperations = new Map();
  const PENDING_STORAGE_KEY = 'ct_cloud_pending_operations_v1';
  function readPendingStorage() {
    try { const raw = root.sessionStorage?.getItem(PENDING_STORAGE_KEY); const parsed = raw ? JSON.parse(raw) : {}; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  function writePendingStorage(value) {
    try { if (root.sessionStorage) root.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(value)); } catch { /* In-memory idempotency remains available when storage is disabled. */ }
  }
  function persistPending(pendingId, pending) { const all = readPendingStorage(); all[pendingId] = pending; writePendingStorage(all); }
  function clearPending(pendingId) { pendingOperations.delete(pendingId); const all = readPendingStorage(); delete all[pendingId]; writePendingStorage(all); }
  const stableJson = value => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const randomKey = () => (root.crypto && root.crypto.randomUUID)
    ? root.crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

  class CloudError extends Error {
    constructor(message, status, body) { super(message); this.name = 'CloudError'; this.status = status; this.body = body; }
  }
  async function request(path, options = {}) {
    const response = await root.fetch(`${API}${path}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new CloudError(body.error || `HTTP ${response.status}`, response.status, body);
    return body;
  }
  function assertView(permissions, id) {
    const p = permissions?.portfolios?.[id] || {};
    if (!permissions?.isAdmin && p.view !== true) throw new CloudError(`No view permission for portfolio ${id}`, 403);
  }
  function toLegacyPortfolio(meta, state, transactions, positionOverrides, adjustments = []) {
    const wallet = { USDT: 0, USDC: 0, ...(state.wallets || {}) };
    let journal = Array.isArray(transactions) ? jsonClone(transactions) : [];
    // Users with view but without history receive a state-only projection.
    // Synthetic opening rows preserve the legacy UI's ledger renderer without leaking history.
    if (!Array.isArray(transactions)) journal = [];
    // The Worker emits ISO-8601 timestamps; legacy browser records use epoch ms.
    // Normalize both to epoch milliseconds before any ledger sorting/filtering.
    journal = journal.map(row => { const ts = epochMs(row?.ts ?? row?.timestamp ?? row?.createdAt); return Number.isFinite(ts) ? { ...row, ts } : row; });
    if (!journal.length && Array.isArray(state.positions)) {
      journal = state.positions.map((p, i) => ({
        id: `cloud_state_${meta.id}_${i}`, type: 'opening', asset: p.asset,
        qty: Number(p.qty), price: Number(p.qty) > 0 ? Number(p.cost) / Number(p.qty) : 0,
        quote: p.quote || 'USDT', fee: 0, ts: 0, note: 'Cloud state projection', _cloudProjection: true
      }));
    }
    if (!Array.isArray(transactions)) journal.__cloudRealizedPnl = Object.fromEntries(Object.entries(state.realizedPnl || {}).map(([quote, byAsset]) => [quote, Object.values(byAsset || {}).reduce((sum, value) => sum + (Number(value) || 0), 0)]));
    const mergedOverrides = positionOverrides && typeof positionOverrides === 'object' ? jsonClone(positionOverrides) : {};
    for (const a of (Array.isArray(adjustments) ? adjustments : [])) {
      if (!a || !a.asset) continue;
      const old = mergedOverrides[a.asset];
      const history = Array.isArray(old?.history) ? old.history.slice() : (old && Number.isFinite(+old.qty) ? [{ qty: +old.qty, cost: +old.cost, quote: old.quote || 'USDT', ts: Number.isFinite(+old.ts) ? +old.ts : 0 }] : []);
      history.push({ qty: Number(a.qty), cost: Number(a.cost), quote: a.quote || 'USDT', ts: Number(a.ts || 0) });
      mergedOverrides[a.asset] = { history };
    }
    return {
      id: meta.id, name: meta.name, wallets: wallet, transactions: journal,
      positionOverrides: mergedOverrides,
      _cloudRevision: Number(state.revision || 0), _cloudUpdatedAt: state.updatedAt || meta.updatedAt || null,
      // History permission is known before the journal request completes.
      // Keep it separate from _cloudHasHistory so operations made during
      // progressive startup can append their authorized transaction receipt.
      _cloudHasHistory: Array.isArray(transactions),
      _cloudCanHistory: Array.isArray(transactions) || meta._cloudCanHistory === true
    };
  }

  async function bootstrap() {
    // Identity and permission-filtered shared collections are the startup gate.
    // Spot portfolio states, transaction histories and Options cash are loaded
    // independently after this point and streamed to the page as each is ready.
    const me = await request('/me');
    if (!me.user || !me.user.provisioned || me.user.blocked) throw new CloudError('Account is not provisioned for Crypto Terminal Cloud', 403, me);
    const user = me.user;
    const permissions = user.permissions || { portfolios: {} };
    const isAdmin = user.isAdmin === true;
    const [index, collectionsResult] = await Promise.all([
      request('/workspaces/main/portfolios'),
      request('/workspaces/main/collections').catch(error => {
        if (error.status === 403) return { collections: {}, revision: 0, deniedKeys: [] };
        throw error;
      })
    ]);

    root.__CT_CLOUD_PROGRESS_QUEUE__ = [];
    root.__CT_CLOUD_PROGRESS_HANDLER__ = null;
    const emit = event => {
      if (typeof root.__CT_CLOUD_PROGRESS_HANDLER__ === 'function') {
        try { root.__CT_CLOUD_PROGRESS_HANDLER__(event); } catch (error) { console.error('Cloud progressive update failed', error); }
      } else root.__CT_CLOUD_PROGRESS_QUEUE__.push(event);
    };
    const portfolioMetas = index.portfolios || [];
    // Start every portfolio branch immediately. State is delivered first so
    // the Spot block can render before slower transaction history arrives.
    Promise.all(portfolioMetas.map(async meta => {
      try {
        assertView({ ...(!Array.isArray(permissions) ? permissions : {}), isAdmin }, meta.id);
        const encodedId = encodeURIComponent(meta.id);
        const stateResult = await request(`/workspaces/main/portfolios/${encodedId}/state`);
        const state = stateResult.state || {};
        const hasHistory = isAdmin || permissions.portfolios?.[meta.id]?.history === true;
        const stateOnly = toLegacyPortfolio({ ...meta, _cloudCanHistory: hasHistory }, state, null, null);
        emit({ type: 'portfolio', phase: 'state', portfolio: stateOnly });
        if (!hasHistory) {
          emit({ type: 'portfolio', phase: 'complete', portfolio: stateOnly });
          return;
        }
        const [historyResult, adjustmentResult] = await Promise.all([
          request(`/workspaces/main/portfolios/${encodedId}/transactions`).catch(error => { if (error.status === 403) return null; throw error; }),
          request(`/workspaces/main/portfolios/${encodedId}/adjustments`).catch(error => { if (error.status === 403) return null; throw error; })
        ]);
        const complete = toLegacyPortfolio(meta, state, historyResult?.transactions, historyResult?.positionOverrides, adjustmentResult?.adjustments);
        emit({ type: 'portfolio', phase: 'complete', portfolio: complete });
      } catch (error) {
        emit({ type: 'portfolio-error', id: meta.id, name: meta.name, error: error.message || String(error) });
      }
    })).then(() => emit({ type: 'portfolios-complete' }));

    if (isAdmin || permissions.global?.options === true) {
      request('/options/main/cash').then(optionsCash => emit({ type: 'options-cash', optionsCash }))
        .catch(error => emit({ type: 'options-cash-error', error: error.message || String(error) }));
    } else emit({ type: 'options-cash', optionsCash: null });

    return {
      user, permissions, portfolios: [], optionsCash: null,
      collections: collectionsResult.collections || {},
      collectionsRevision: Number(collectionsResult.revision || 0),
      deniedKeys: collectionsResult.deniedKeys || [],
      progressive: true,
      portfolioCount: portfolioMetas.length
    };
  }

  async function operate(portfolio, operation) {
    if (!portfolio || !portfolio.id) throw new CloudError('Portfolio is not selected', 400);
    const type = operation.type;
    const required = ['buy', 'sell'].includes(type) ? 'trade'
      : ['deposit', 'withdraw', 'exchange'].includes(type) ? 'funds'
      : ['manualEdit', 'dustCleanup'].includes(type) ? 'edit' : null;
    if (!required) throw new CloudError(`Unsupported operation: ${type}`, 400);
    const pendingId = `${portfolio.id}:${stableJson(operation)}`;
    let pending = pendingOperations.get(pendingId) || readPendingStorage()[pendingId];
    if (!pending) pending = { key: `ct_${randomKey()}`, operation: { ...operation, ts: Number(operation.ts || Date.now()) } };
    pendingOperations.set(pendingId, pending);
    persistPending(pendingId, pending);
    const normalizedOperation = pending.operation;
    const idempotencyKey = pending.key;
    const response = await request(`/workspaces/main/portfolios/${encodeURIComponent(portfolio.id)}/operations`, {
      method: 'POST', body: {
        expectedRevision: Number(portfolio._cloudRevision || 0),
        idempotencyKey,
        operation: normalizedOperation
      }
    });
    // A replay means the server already committed this idempotency key. The
    // local journal may not contain that commit (for example, the first HTTP
    // response was lost), so force the caller to reload the authoritative
    // state and history before another operation can be submitted.
    if (response.replayed) {
      clearPending(pendingId);
      throw new CloudError('Operation was already committed; reload portfolio state before continuing', 409, response);
    }
    if (response.state) {
      clearPending(pendingId);
      portfolio.wallets = { USDT: 0, USDC: 0, ...(response.state.wallets || {}) };
      portfolio._cloudRevision = Number(response.state.revision || response.revision || portfolio._cloudRevision + 1);
      portfolio._cloudUpdatedAt = response.state.updatedAt || response.updatedAt || null;
      // A server operation response may omit history by design. Append only the authorized receipt row.
      if (portfolio._cloudCanHistory && response.transaction) {
        const receipt = jsonClone(response.transaction);
        const receiptTs = epochMs(receipt.ts ?? receipt.timestamp ?? receipt.createdAt);
        if (Number.isFinite(receiptTs)) receipt.ts = receiptTs;
        const receiptId = receipt.id == null ? null : String(receipt.id);
        const alreadyPresent = portfolio.transactions.some(t =>
          (receiptId && t.id != null && String(t.id) === receiptId) ||
          (!receiptId && t.type === receipt.type && t.ts === receipt.ts && t.asset === receipt.asset &&
            Number(t.qty) === Number(receipt.qty) && Number(t.price) === Number(receipt.price))
        );
        if (!alreadyPresent) portfolio.transactions.push(receipt);
        portfolio._cloudHasHistory = true;
      }
      if (portfolio._cloudHasHistory && response.adjustment) {
        portfolio.positionOverrides = portfolio.positionOverrides || {};
        const old = portfolio.positionOverrides[response.adjustment.asset];
        const history = Array.isArray(old?.history) ? old.history.slice() : [];
        history.push({ qty: response.adjustment.qty, cost: response.adjustment.cost, quote: response.adjustment.quote, ts: response.adjustment.ts });
        portfolio.positionOverrides[response.adjustment.asset] = { history };
      }
      // Replace local ledger with the authoritative state projection. When history is granted,
      // keep the full journal and adjustments returned by the history endpoint on refresh.
      portfolio._cloudState = jsonClone(response.state);
      if (!portfolio._cloudHasHistory) {
        portfolio.transactions = toLegacyPortfolio({ id: portfolio.id, name: portfolio.name }, response.state, null, {}).transactions;
        portfolio.positionOverrides = {};
      }
    } else {
      // Idempotent replay responses may include only a receipt. Force a reload before another command.
      throw new CloudError('Operation replayed; reload portfolio state before continuing', 409, response);
    }
    return response;
  }

  async function reloadPortfolio(portfolio) {
    const stateResult = await request(`/workspaces/main/portfolios/${encodeURIComponent(portfolio.id)}/state`);
    const state = stateResult.state || {};
    portfolio.wallets = { USDT: 0, USDC: 0, ...(state.wallets || {}) };
    portfolio._cloudState = jsonClone(state);
    portfolio._cloudRevision = Number(state.revision || 0);
    portfolio._cloudUpdatedAt = state.updatedAt || null;
    const canHistory = portfolio._cloudCanHistory === true;
    const [history, adjustmentResult] = canHistory ? await Promise.all([
      request(`/workspaces/main/portfolios/${encodeURIComponent(portfolio.id)}/transactions`).catch(error => { if (error.status === 403) return null; throw error; }),
      request(`/workspaces/main/portfolios/${encodeURIComponent(portfolio.id)}/adjustments`).catch(error => { if (error.status === 403) return null; throw error; })
    ]) : [null, null];
    if (history) {
      portfolio._cloudHasHistory = true;
      const merged = toLegacyPortfolio({ id: portfolio.id, name: portfolio.name }, state, history.transactions || [], history.positionOverrides || {}, adjustmentResult?.adjustments || []);
      portfolio.transactions = merged.transactions;
      portfolio.positionOverrides = merged.positionOverrides;
    } else {
      portfolio._cloudHasHistory = false;
      portfolio.transactions = toLegacyPortfolio({ id: portfolio.id, name: portfolio.name }, state, null, {}).transactions;
      portfolio.positionOverrides = {};
    }
    return portfolio;
  }

  async function getOptionsCash() { return request('/options/main/cash'); }
  async function operateOptionsCash(operation, expectedRevision) {
    const idempotencyKey = `ct_optcash_${randomKey()}`;
    return request('/options/main/cash', { method: 'POST', body: { expectedRevision: Number(expectedRevision || 0), operation: { ...operation, idempotencyKey } } });
  }
  async function operateOptionsPortfolio(operation, expectedCashRevision, positions, closed) {
    const operations = (Array.isArray(operation) ? operation : [operation]).map(op => ({
      ...op, idempotencyKey: op.idempotencyKey || `ct_optportfolio_${randomKey()}`
    }));
    return request('/options/main/portfolio-operation', { method: 'POST', body: {
      expectedCashRevision: Number(expectedCashRevision || 0),
      operations,
      collections: { ct_options_portfolio_v1: positions, ct_options_portfolio_v1_closed: closed }
    } });
  }

  async function saveCollections(collections, revision) {
    const allowed = {};
    for (const key of COLLECTION_KEYS) if (Object.prototype.hasOwnProperty.call(collections, key)) allowed[key] = collections[key];
    try {
      return await request('/workspaces/main/collections', { method: 'PUT', body: { expectedRevision: revision, collections: allowed } });
    } catch (error) {
      // A different user may have saved another shared collection after our
      // bootstrap. The API merges only supplied keys, so refresh the revision
      // and retry this same partial patch once without overwriting other keys.
      if (error.status !== 409) throw error;
      const current = await request('/workspaces/main/collections');
      return request('/workspaces/main/collections', { method: 'PUT', body: { expectedRevision: Number(current.revision || 0), collections: allowed } });
    }
  }

  async function adminUsers() { return request('/admin/users'); }
  async function saveUser(record) { return request('/admin/users', { method: 'PUT', body: record }); }
  async function setAdminRole(email, isAdmin) { return request('/admin/users/role', { method: 'PUT', body: { email, isAdmin: !!isAdmin } }); }
  async function adminAudit() { return request('/admin/audit'); }
  async function importMigration(payload) { return request('/admin/portfolios/import', { method: 'POST', body: { payload } }); }
  async function createPortfolio(name) {
    const created = await request('/admin/portfolios', { method: 'POST', body: { name } });
    // Granting access is deliberately a separate explicit action; this helper does not grant it.
    return { ...created, permissionsUnchanged: true };
  }
  async function renamePortfolio(id, name) { return request(`/admin/portfolios/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }); }
  async function archivePortfolio(id) { return request(`/admin/portfolios/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

  root.CryptoTerminalCloud = Object.freeze({
    CloudError, request, bootstrap, operate, reloadPortfolio, saveCollections, getOptionsCash, operateOptionsCash, operateOptionsPortfolio,
    adminUsers, saveUser, setAdminRole, adminAudit, importMigration, createPortfolio, renamePortfolio, archivePortfolio,
    permissions: PERMISSIONS
  });
})(window);
