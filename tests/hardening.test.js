/**
 * Integration tests for HARDENING.md findings #2 (silent layout save), #3
 * (templates), #4 (compilation-verified add), #5 (watchlist REST API), #6
 * (chart-ready), #7 (no caching), and #8 (idempotent removal).
 *
 * Run: node --test tests/hardening.test.js
 * Requires: TradingView Desktop with --remote-debugging-port=9222
 *
 * NOTE: these tests create + delete user data on the live TV account
 * (test layouts named MCP_TEST_*, test watchlists named MCP_TEST_WL_*).
 * Every test cleans up after itself; if a test crashes, manually remove
 * anything starting with "MCP_TEST_".
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import CDP from 'chrome-remote-interface';
import * as chartCore from '../src/core/chart.js';
import * as layoutCore from '../src/core/layout.js';
import * as watchlistCore from '../src/core/watchlist.js';
import * as templatesCore from '../src/core/templates.js';
import { evaluate, evaluateAsync } from '../src/connection.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('Hardening — findings #2, #3, #4, #5, #6, #7, #8', () => {
  let client;
  let createdLayoutIds = [];
  let createdWatchlistIds = [];

  before(async () => {
    const targets = await CDP.List({ host: 'localhost', port: 9222 });
    const target = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
    if (!target) {
      console.error('Cannot find TradingView chart target.');
      process.exit(1);
    }
    client = await CDP({ host: 'localhost', port: 9222, target: target.id });
    await client.Runtime.enable();
  });

  after(async () => {
    // Best-effort cleanup of layouts, watchlists, templates we created.
    for (const id of createdLayoutIds) {
      try { await layoutCore.remove({ name_or_id: id }); } catch (e) { console.warn('cleanup layout', id, e.message); }
    }
    for (const id of createdWatchlistIds) {
      try { await watchlistCore.remove({ name_or_id: id }); } catch (e) { console.warn('cleanup watchlist', id, e.message); }
    }
    // Template cleanup — best effort
    try {
      const tpls = await templatesCore.list();
      for (const t of tpls.templates) {
        if (t.name && t.name.startsWith('MCP_TEST_TPL_')) {
          try { await templatesCore.remove({ name: t.name }); } catch {}
        }
      }
    } catch {}
    if (client) try { await client.close(); } catch {}
  });

  // ─── Finding #7: layout_list is uncached ──────────────────────────────
  describe('Finding #7 — uncached layout_list', () => {
    it('returns fresh data on every call', async () => {
      const first = await layoutCore.list();
      assert.ok(first.success);
      assert.ok(Array.isArray(first.layouts));
      const second = await layoutCore.list();
      assert.equal(second.layouts.length, first.layouts.length, 'consistent count');
      // ids should match
      const ids1 = first.layouts.map(l => l.id).sort();
      const ids2 = second.layouts.map(l => l.id).sort();
      assert.deepEqual(ids1, ids2);
    });
  });

  // ─── Finding #2: layout_save_as ───────────────────────────────────────
  describe('Finding #2 — silent layout_save_as', () => {
    it('creates a new layout without showing a dialog', async () => {
      const before = await layoutCore.list();
      const cur = await layoutCore.current();
      const name = `MCP_TEST_LAYOUT_${Date.now()}`;

      const res = await layoutCore.saveAs({ name });
      assert.equal(res.success, true);
      assert.ok(res.layout_id, 'returns new layout id');
      assert.equal(res.name, name);
      createdLayoutIds.push(res.layout_id);

      // Original layout is untouched: count goes up by one, original is still there.
      const after = await layoutCore.list();
      assert.equal(after.layouts.length, before.layouts.length + 1);
      const newLayout = after.layouts.find(l => l.id === res.layout_id);
      assert.ok(newLayout, 'new layout in list');
      assert.equal(newLayout.name, name);
      if (cur.id) {
        const orig = after.layouts.find(l => l.id === cur.id);
        assert.ok(orig, 'original layout still present');
      }

      // Local chart stays on the original (stay_on_original default = true)
      const curAfter = await layoutCore.current();
      assert.equal(curAfter.id, cur.id, 'local chart still on original layout id');
    });

    it('on_conflict:"error" rejects duplicate names', async () => {
      const layouts = await layoutCore.list();
      // Pick any existing layout name to conflict with.
      const existing = layouts.layouts.find(l => l.name);
      if (!existing) {
        return; // no layouts to conflict with
      }
      await assert.rejects(
        layoutCore.saveAs({ name: existing.name, on_conflict: 'error' }),
        /already exists/i
      );
    });

    it('on_conflict:"overwrite" replaces the same-named layout', async () => {
      // First create a layout
      const name = `MCP_TEST_LAYOUT_OW_${Date.now()}`;
      const r1 = await layoutCore.saveAs({ name });
      createdLayoutIds.push(r1.layout_id);

      // Then save-as again with the same name, on_conflict:overwrite
      const r2 = await layoutCore.saveAs({ name, on_conflict: 'overwrite' });
      assert.equal(r2.success, true);
      assert.notEqual(r2.layout_id, r1.layout_id, 'new id from overwrite');
      // Remove r1 from cleanup (already deleted)
      createdLayoutIds = createdLayoutIds.filter(id => id !== r1.layout_id);
      createdLayoutIds.push(r2.layout_id);

      const all = await layoutCore.list();
      const same = all.layouts.filter(l => l.name === name);
      assert.equal(same.length, 1, 'exactly one layout with that name after overwrite');
    });
  });

  // ─── Finding #5: watchlist REST API ───────────────────────────────────
  describe('Finding #5 — watchlist data layer', () => {
    let wlId;
    const wlName = `MCP_TEST_WL_${Date.now()}`;

    it('creates a watchlist, populates it, reads it, and deletes it — without any UI', async () => {
      const created = await watchlistCore.create({ name: wlName });
      assert.equal(created.success, true);
      wlId = created.id;
      createdWatchlistIds.push(wlId);

      // List shows it
      const list1 = await watchlistCore.list();
      const found = list1.watchlists.find(w => w.id === wlId);
      assert.ok(found, 'new watchlist in list');
      assert.equal(found.name, wlName);

      // Batch add unique symbols + sections (TV's API de-duplicates)
      const symbols = [
        '###Indices', 'AMEX:SPY', 'NASDAQ:QQQ', 'TVC:DJI',
        '###Tech', 'NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:GOOGL', 'NASDAQ:META', 'NASDAQ:NFLX',
        '###Energy', 'AMEX:XLE', 'NYSE:XOM', 'NYSE:CVX',
        '###Crypto', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT',
      ];
      const added = await watchlistCore.addBatch({ symbols, watchlist: wlId });
      assert.equal(added.success, true);
      assert.ok(added.symbols_now.length >= symbols.length, `expected at least ${symbols.length} symbols after add, got ${added.symbols_now.length}`);

      // Section divider preserved
      assert.ok(added.symbols_now[0].startsWith('###'), 'section divider in result');

      // Single add
      const one = await watchlistCore.add({ symbol: 'NASDAQ:NVDA', watchlist: wlId });
      assert.equal(one.success, true);

      // Read back full contents
      const got = await watchlistCore.get({ name_or_id: wlId });
      assert.equal(got.success, true);
      assert.ok(got.symbols.includes('NASDAQ:NVDA'));
      assert.ok(got.symbols.some(s => s.startsWith('###Indices')));

      // Remove symbols
      const removed = await watchlistCore.removeSymbols({ symbols: ['NASDAQ:NVDA'], watchlist: wlId });
      assert.equal(removed.success, true);
      assert.ok(!removed.symbols_now.includes('NASDAQ:NVDA'));

      // Rename
      const renamed = await watchlistCore.rename({ name_or_id: wlId, new_name: wlName + '_RENAMED' });
      assert.equal(renamed.success, true);

      // Delete
      const del = await watchlistCore.remove({ name_or_id: wlId });
      assert.equal(del.success, true);
      createdWatchlistIds = createdWatchlistIds.filter(id => id !== wlId);

      // Verify it's gone
      const list2 = await watchlistCore.list();
      assert.equal(list2.watchlists.find(w => w.id === wlId), undefined, 'deleted watchlist removed from list');
    });

    it('exposes the active watchlist', async () => {
      const active = await watchlistCore.getActive();
      // success may be false if there's no active list — both are acceptable
      assert.ok(typeof active.success === 'boolean');
      if (active.success) {
        assert.ok(active.id, 'active id present');
        assert.ok(Array.isArray(active.symbols), 'symbols array present');
      }
    });
  });

  // ─── Finding #6: chart_wait_ready ─────────────────────────────────────
  describe('Finding #6 — chart_wait_ready', () => {
    let originalSymbol;

    before(async () => {
      originalSymbol = await evaluate('window.TradingViewApi.chart(0).symbol()');
    });

    after(async () => {
      try { await chartCore.setSymbol({ symbol: originalSymbol, pane_index: 0 }); } catch {}
    });

    it('returns ready=true within timeout after a symbol change', async () => {
      await chartCore.setSymbol({ symbol: 'AAPL', pane_index: 0 });
      const r = await chartCore.waitReady({ pane_index: 0, timeout_ms: 8000 });
      assert.equal(r.ready, true, 'data ready after symbol change');
      assert.ok(r.symbol && r.symbol.toUpperCase().includes('AAPL'));
    });
  });

  // ─── Finding #4: compilation-verified indicator add ───────────────────
  describe('Finding #4 — compilation-verified indicator add', () => {
    let addedIds = [];

    after(async () => {
      for (const id of addedIds) {
        try { await evaluate(`window.TradingViewApi.chart(0).removeEntity(${JSON.stringify(id)})`); } catch {}
      }
    });

    it('adds Volume and reports compilation_status:"ok"', async () => {
      const r = await chartCore.manageIndicator({ action: 'add', indicator: 'Volume', pane_index: 0 });
      assert.equal(r.success, true);
      assert.equal(r.compilation_status, 'ok');
      assert.ok(r.entity_id);
      addedIds.push(r.entity_id);
    });

    it('returns success=false when the indicator name is invalid', async () => {
      const r = await chartCore.manageIndicator({ action: 'add', indicator: 'TotallyMadeUpIndicatorXYZ', pane_index: 0 });
      assert.equal(r.success, false);
      assert.ok(r.error, 'error reported');
    });
  });

  // ─── Finding #8: idempotent study removal ─────────────────────────────
  describe('Finding #8 — idempotent removal', () => {
    it('removing a missing entity_id returns success with already_removed=true', async () => {
      const r = await chartCore.manageIndicator({ action: 'remove', entity_id: 'doesNotExist123', indicator: '_' });
      assert.equal(r.success, true);
      assert.equal(r.already_removed, true);
    });

    it('removing a real study removes it from every pane', async () => {
      const added = await chartCore.manageIndicator({ action: 'add', indicator: 'Volume', pane_index: 0 });
      assert.equal(added.success, true);

      const removed = await chartCore.manageIndicator({ action: 'remove', entity_id: added.entity_id, indicator: '_' });
      assert.equal(removed.success, true);

      // Verify it's truly gone from every pane. getStudyById throws when missing,
      // so wrap the check in a try/catch inside the page context.
      const foundAnywhere = await evaluate(`
        (function(){
          var n = window.TradingViewApi.chartsCount();
          for (var i = 0; i < n; i++) {
            try {
              if (window.TradingViewApi.chart(i).getStudyById(${JSON.stringify(added.entity_id)})) return true;
            } catch(e) {}
          }
          return false;
        })()
      `);
      assert.equal(foundAnywhere, false, 'removed study not present in any pane');
    });
  });

  // ─── Finding #3: indicator template apply (silent path) ───────────────
  describe('Finding #3 — indicator template apply', () => {
    let availableTemplate;

    before(async () => {
      const tpls = await templatesCore.list();
      // Pick the first user template (any name).
      availableTemplate = tpls.templates.find(t => !t.is_default) || tpls.templates[0];
    });

    it('lists existing templates', async () => {
      const tpls = await templatesCore.list();
      assert.equal(tpls.success, true);
      assert.ok(Array.isArray(tpls.templates));
      assert.ok(tpls.template_count >= 0);
    });

    it('applies a template silently to a pane', async () => {
      if (!availableTemplate) {
        // No templates available — skip
        return;
      }
      const r = await templatesCore.apply({ name: availableTemplate.name, pane_index: 0 });
      assert.equal(r.success, true);
      assert.ok(Array.isArray(r.studies));
      assert.ok(r.studies.length > 0, 'template applied with at least one study');

      // Clean up: remove the applied studies (best effort)
      for (const s of r.studies) {
        try { await evaluate(`window.TradingViewApi.chart(0).removeEntity(${JSON.stringify(s.id)})`); } catch {}
      }
    });
  });
});
