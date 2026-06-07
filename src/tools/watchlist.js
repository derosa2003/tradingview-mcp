import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get the active watchlist with all its symbols (including ###Section dividers). Hits TradingView\'s REST API — works whether the sidebar is open or not.', {}, async () => {
    try { return jsonResult(await core.getActive()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_list', 'List all custom watchlists with their id, name, and symbol count.', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_get_one', 'Read a specific watchlist by name or id, returning all symbols and section dividers.', {
    name_or_id: z.string().describe('Watchlist name (case-insensitive) or numeric id'),
  }, async ({ name_or_id }) => {
    try { return jsonResult(await core.get({ name_or_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Append a symbol to a watchlist (default: the active one). Uses TradingView\'s REST API — works regardless of sidebar visibility.', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, NYMEX:CL1!). Prefix with "###" to insert a section divider — but prefer watchlist_add_section for that.'),
    watchlist: z.string().optional().describe('Target watchlist name or id (default: active watchlist)'),
  }, async ({ symbol, watchlist }) => {
    try { return jsonResult(await core.add({ symbol, watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add_batch', 'Append many symbols at once. Insert section dividers by including "###Section Name" entries in the symbols array.', {
    symbols: z.array(z.string()).describe('Symbols to add in order. Use "###Section Name" for section dividers.'),
    watchlist: z.string().optional().describe('Target watchlist name or id (default: active watchlist)'),
  }, async ({ symbols, watchlist }) => {
    try { return jsonResult(await core.addBatch({ symbols, watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add_section', 'Append a "###Section Name" divider to a watchlist.', {
    name: z.string().describe('Section title (e.g., "Energy", "AI/Tech")'),
    watchlist: z.string().optional().describe('Target watchlist (default: active)'),
  }, async ({ name, watchlist }) => {
    try { return jsonResult(await core.addSection({ name, watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_remove', 'Remove one or more symbols from a watchlist.', {
    symbols: z.array(z.string()).describe('Symbols to remove'),
    watchlist: z.string().optional().describe('Target watchlist (default: active)'),
  }, async ({ symbols, watchlist }) => {
    try { return jsonResult(await core.removeSymbols({ symbols, watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_create', 'Create a new watchlist, optionally pre-populated.', {
    name: z.string().describe('Name of the new watchlist'),
    symbols: z.array(z.string()).optional().describe('Optional initial symbols (and ###Section dividers)'),
  }, async ({ name, symbols }) => {
    try { return jsonResult(await core.create({ name, symbols: symbols || [] })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_delete', 'Delete a watchlist by name or id.', {
    name_or_id: z.string().describe('Watchlist name or id'),
  }, async ({ name_or_id }) => {
    try { return jsonResult(await core.remove({ name_or_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_set_active', 'Mark a watchlist as the active one (the sidebar will switch to display it).', {
    name_or_id: z.string().describe('Watchlist name or id'),
  }, async ({ name_or_id }) => {
    try { return jsonResult(await core.setActive({ name_or_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_rename', 'Rename a watchlist.', {
    name_or_id: z.string().describe('Existing watchlist name or id'),
    new_name: z.string().describe('New name'),
  }, async ({ name_or_id, new_name }) => {
    try { return jsonResult(await core.rename({ name_or_id, new_name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
