/**
 * Watchlist data-layer access via TradingView's REST endpoints.
 *
 * The previous UI-click approach (clicking the "+ Add symbol" button in the
 * watchlist sidebar) failed whenever the sidebar wasn't open or the panel
 * was resized. We instead hit the same backend endpoints the sidebar itself
 * calls — works regardless of UI state.
 *
 * Endpoints (all under https://www.tradingview.com/api/v1/symbols_list/):
 *   GET    /custom/                    list custom watchlists
 *   POST   /custom/                    create (FormData: name=...)
 *   GET    /custom/{id}/               read one
 *   DELETE /custom/{id}/               delete
 *   POST   /custom/{id}/append/        JSON array — add symbols (extends)
 *   POST   /custom/{id}/remove/        JSON array — remove symbols
 *   POST   /custom/{id}/replace/       JSON array — reorder existing only
 *   POST   /custom/{id}/rename/        FormData (name=...)
 *   POST   /active/{id}/               set active watchlist
 *
 * Section dividers use the `###Section Name` symbol convention.
 *
 * Fetches run inside the TradingView page context so the session cookies
 * are sent automatically (no extra auth handling needed).
 */
import { evaluateAsync, safeString } from '../connection.js';

const BASE = 'https://www.tradingview.com/api/v1/symbols_list';

/**
 * Run a fetch inside the TradingView page so credentials are carried.
 */
async function call(method, url, opts = {}) {
  let bodyExpr = '';
  if (opts.json !== undefined) {
    bodyExpr = `headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(opts.json))},`;
  } else if (opts.form) {
    bodyExpr = `body: (function(){ var fd = new FormData(); var f = ${JSON.stringify(opts.form)}; for (var k in f) fd.append(k, f[k]); return fd; })(),`;
  }
  const expr = `
    (async function(){
      var r = await fetch(${safeString(url)}, {
        method: ${safeString(method)},
        credentials: 'include',
        ${bodyExpr}
      });
      var txt = await r.text();
      var parsed = null;
      try { parsed = txt ? JSON.parse(txt) : null; } catch(e) {}
      return { status: r.status, body: txt, parsed: parsed };
    })()
  `;
  return evaluateAsync(expr);
}

function _ensureOk(res, op) {
  if (res.status >= 200 && res.status < 300) return res;
  const detail = res.parsed?.detail || res.parsed?.code || res.body?.slice(0, 200) || `HTTP ${res.status}`;
  throw new Error(`Watchlist ${op} failed: ${detail}`);
}

/** List all custom watchlists. Always fetches fresh. */
export async function list() {
  const res = _ensureOk(await call('GET', `${BASE}/custom/`), 'list');
  const wls = Array.isArray(res.parsed) ? res.parsed : [];
  return {
    success: true,
    watchlist_count: wls.length,
    watchlists: wls.map(w => ({
      id: w.id,
      name: w.name,
      symbol_count: (w.symbols || []).length,
      active: !!w.active,
      modified: w.modified,
    })),
  };
}

/** Get the currently-active watchlist with all symbols. */
export async function getActive() {
  const id = await evaluateAsync(`window.TVD.getActiveWatchlistId()`);
  if (!id) {
    return { success: false, error: 'No active watchlist (TVD.getActiveWatchlistId returned null)' };
  }
  const res = _ensureOk(await call('GET', `${BASE}/custom/${id}/`), 'get_active');
  return { success: true, id, name: res.parsed?.name, symbols: res.parsed?.symbols || [] };
}

/** Get a watchlist's contents by name or id. */
export async function get({ name_or_id }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  const id = await _resolveId(name_or_id);
  const res = _ensureOk(await call('GET', `${BASE}/custom/${id}/`), 'get');
  return { success: true, id, name: res.parsed?.name, symbols: res.parsed?.symbols || [] };
}

/** Create a new watchlist. Returns the new id. */
export async function create({ name, symbols = [] }) {
  if (!name || typeof name !== 'string') throw new Error('name is required (string)');
  const res = _ensureOk(await call('POST', `${BASE}/custom/`, { form: { name } }), 'create');
  const newId = res.parsed?.id;
  if (!newId) throw new Error('No id returned from create');
  if (symbols.length > 0) {
    _ensureOk(await call('POST', `${BASE}/custom/${newId}/append/`, { json: symbols }), 'create_append');
  }
  return { success: true, id: newId, name, symbol_count: symbols.length };
}

/** Delete a watchlist by name or id. */
export async function remove({ name_or_id }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  const id = await _resolveId(name_or_id);
  _ensureOk(await call('DELETE', `${BASE}/custom/${id}/`), 'delete');
  return { success: true, deleted_id: id };
}

/** Set the active watchlist. */
export async function setActive({ name_or_id }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  const id = await _resolveId(name_or_id);
  _ensureOk(await call('POST', `${BASE}/active/${id}/`, { json: {} }), 'set_active');
  return { success: true, active_id: id };
}

/**
 * Add one or more symbols to a watchlist (or the active one).
 * Use `###Section Name` as a symbol to insert a section divider.
 */
export async function addBatch({ symbols, watchlist }) {
  if (!Array.isArray(symbols) || symbols.length === 0) throw new Error('symbols must be a non-empty array');
  const id = watchlist ? await _resolveId(watchlist) : await evaluateAsync(`window.TVD.getActiveWatchlistId()`);
  if (!id) throw new Error('No target watchlist (no active and no watchlist arg)');
  const res = _ensureOk(await call('POST', `${BASE}/custom/${id}/append/`, { json: symbols }), 'append');
  return { success: true, watchlist_id: id, symbols_now: res.parsed || [], added: symbols };
}

/** Add a single symbol (backwards-compatible wrapper for the legacy `watchlist_add` tool). */
export async function add({ symbol, watchlist }) {
  if (!symbol) throw new Error('symbol is required');
  const r = await addBatch({ symbols: [symbol], watchlist });
  return { success: true, watchlist_id: r.watchlist_id, symbol, action: 'added' };
}

/** Remove one or more symbols. */
export async function removeSymbols({ symbols, watchlist }) {
  if (!Array.isArray(symbols) || symbols.length === 0) throw new Error('symbols must be a non-empty array');
  const id = watchlist ? await _resolveId(watchlist) : await evaluateAsync(`window.TVD.getActiveWatchlistId()`);
  if (!id) throw new Error('No target watchlist');
  const res = _ensureOk(await call('POST', `${BASE}/custom/${id}/remove/`, { json: symbols }), 'remove_symbols');
  return { success: true, watchlist_id: id, symbols_now: res.parsed || [], removed: symbols };
}

/** Insert a section divider (uses the `###Section Name` symbol convention). */
export async function addSection({ name, watchlist }) {
  if (!name || typeof name !== 'string') throw new Error('name is required (string)');
  return addBatch({ symbols: [`###${name}`], watchlist });
}

/** Rename a watchlist. */
export async function rename({ name_or_id, new_name }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  if (!new_name || typeof new_name !== 'string') throw new Error('new_name is required (string)');
  const id = await _resolveId(name_or_id);
  _ensureOk(await call('POST', `${BASE}/custom/${id}/rename/`, { form: { name: new_name } }), 'rename');
  return { success: true, id, name: new_name };
}

async function _resolveId(name_or_id) {
  const target = String(name_or_id);
  if (/^\d+$/.test(target)) return Number(target);
  const list_ = await list();
  const lower = target.toLowerCase();
  const match = list_.watchlists.find(w => (w.name || '').toLowerCase() === lower)
             || list_.watchlists.find(w => (w.name || '').toLowerCase().includes(lower));
  if (!match) throw new Error(`No watchlist matching "${name_or_id}"`);
  return match.id;
}
