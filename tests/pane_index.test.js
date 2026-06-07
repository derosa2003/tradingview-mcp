/**
 * Acceptance tests for Finding #1 — explicit `pane_index` parameter.
 *
 * Verifies that chart-pane operations target a specific pane deterministically
 * via `TradingViewApi.chart(N)` rather than depending on which pane is focused.
 *
 * Requires TradingView Desktop running with --remote-debugging-port=9222.
 * Run: node --test tests/pane_index.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import CDP from 'chrome-remote-interface';
import * as chartCore from '../src/core/chart.js';
import * as dataCore from '../src/core/data.js';
import * as paneCore from '../src/core/pane.js';
import * as indicatorsCore from '../src/core/indicators.js';
import { evaluate } from '../src/connection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('Finding #1 — pane_index targeting', () => {
  let client;
  let originalLayout;
  let preExistingStudyIdsByPane;

  before(async () => {
    // Sanity: the CDP target must exist.
    const targets = await CDP.List({ host: 'localhost', port: 9222 });
    const target = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
    if (!target) {
      console.error('Cannot find TradingView chart target. Is TradingView Desktop running with --remote-debugging-port=9222?');
      process.exit(1);
    }
    client = await CDP({ host: 'localhost', port: 9222, target: target.id });
    await client.Runtime.enable();

    // Capture current layout so we can restore it after the test.
    originalLayout = await evaluate(`
      (function(){
        var lt = window.TradingViewApi._chartWidgetCollection._layoutType;
        if (typeof lt === 'object' && lt && typeof lt.value === 'function') return lt.value();
        return lt;
      })()
    `);

    // Switch to a 4-pane (2x2) layout for the test.
    await evaluate(`window.TradingViewApi._chartWidgetCollection.setLayout('4')`);
    // Wait for chartsCount to settle to 4.
    for (let i = 0; i < 40 && (await evaluate('window.TradingViewApi.chartsCount()')) !== 4; i++) {
      await sleep(100);
    }
    await sleep(800); // extra settle for data sources

    // Snapshot study IDs per pane before the test, so we can identify "new" studies.
    preExistingStudyIdsByPane = await evaluate(`
      (function(){
        var n = window.TradingViewApi.chartsCount();
        var out = [];
        for (var i = 0; i < n; i++) {
          out.push(window.TradingViewApi.chart(i).getAllStudies().map(s => s.id));
        }
        return out;
      })()
    `);
  });

  after(async () => {
    // Best-effort cleanup: remove anything we added.
    try {
      const after = await evaluate(`
        (function(){
          var n = window.TradingViewApi.chartsCount();
          var out = [];
          for (var i = 0; i < n; i++) {
            out.push(window.TradingViewApi.chart(i).getAllStudies().map(s => s.id));
          }
          return out;
        })()
      `);
      for (let i = 0; i < after.length; i++) {
        const before = preExistingStudyIdsByPane[i] || [];
        const added = after[i].filter(id => !before.includes(id));
        for (const id of added) {
          await evaluate(`window.TradingViewApi.chart(${i}).removeEntity(${JSON.stringify(id)})`);
        }
      }
    } catch (e) {
      console.warn('Cleanup warning:', e.message);
    }
    // Restore layout.
    if (originalLayout) {
      try { await evaluate(`window.TradingViewApi._chartWidgetCollection.setLayout(${JSON.stringify(originalLayout)})`); } catch {}
    }
    if (client) try { await client.close(); } catch {}
  });

  it('chartsCount is 4 after switching to 2x2 layout', async () => {
    const n = await evaluate('window.TradingViewApi.chartsCount()');
    assert.equal(n, 4, '2x2 layout produces 4 panes');
  });

  it('chart_get_state reports each pane independently', async () => {
    for (let i = 0; i < 4; i++) {
      const state = await chartCore.getState({ pane_index: i });
      assert.equal(state.success, true);
      assert.equal(state.pane_index, i, `pane_index echoed back for pane ${i}`);
      assert.ok(state.symbol, `pane ${i} has a symbol`);
      assert.ok(Array.isArray(state.studies), `pane ${i} returns studies array`);
    }
  });

  it('chart_manage_indicator adds Volume to the target pane only — for all 4 panes', async () => {
    for (let targetPane = 0; targetPane < 4; targetPane++) {
      // Snapshot study counts per pane before the add.
      const beforeCounts = [];
      for (let i = 0; i < 4; i++) {
        const s = await chartCore.getState({ pane_index: i });
        beforeCounts.push(s.studies.length);
      }

      const result = await chartCore.manageIndicator({
        action: 'add',
        indicator: 'Volume',
        pane_index: targetPane,
      });
      assert.equal(result.success, true, `Volume add succeeded on pane ${targetPane}`);
      assert.equal(result.pane_index, targetPane);
      assert.ok(result.entity_id, 'New entity_id returned');

      // Verify only the target pane gained a study.
      for (let i = 0; i < 4; i++) {
        const s = await chartCore.getState({ pane_index: i });
        const delta = s.studies.length - beforeCounts[i];
        if (i === targetPane) {
          assert.equal(delta, 1, `target pane ${i} gained exactly one study (got ${delta})`);
          const hasVolume = s.studies.some(st => st.id === result.entity_id);
          assert.ok(hasVolume, `target pane ${i} contains the new study id ${result.entity_id}`);
        } else {
          assert.equal(delta, 0, `non-target pane ${i} gained zero studies (got ${delta})`);
          const hasVolume = s.studies.some(st => st.id === result.entity_id);
          assert.ok(!hasVolume, `non-target pane ${i} does not contain new study id`);
        }
      }
    }
  });

  it('rapid sequential operations across different panes preserve targeting', async () => {
    // Add a study to pane 3, then pane 0, then pane 2, with no waits in between.
    // The before/after diffs must isolate the new studies to the intended panes.
    const beforeAll = [];
    for (let i = 0; i < 4; i++) {
      const s = await chartCore.getState({ pane_index: i });
      beforeAll.push(s.studies.map(st => st.id));
    }

    const r3 = await chartCore.manageIndicator({ action: 'add', indicator: 'Volume', pane_index: 3 });
    const r0 = await chartCore.manageIndicator({ action: 'add', indicator: 'Volume', pane_index: 0 });
    const r2 = await chartCore.manageIndicator({ action: 'add', indicator: 'Volume', pane_index: 2 });

    assert.ok(r3.success && r0.success && r2.success, 'all three adds succeeded');
    assert.equal(r3.pane_index, 3);
    assert.equal(r0.pane_index, 0);
    assert.equal(r2.pane_index, 2);

    const afterAll = [];
    for (let i = 0; i < 4; i++) {
      const s = await chartCore.getState({ pane_index: i });
      afterAll.push(s.studies.map(st => st.id));
    }

    // pane 1: unchanged
    const newOn1 = afterAll[1].filter(id => !beforeAll[1].includes(id));
    assert.equal(newOn1.length, 0, 'pane 1 has zero new studies');

    // pane 0, 2, 3: each has the corresponding entity_id, and no foreign ids.
    const newOn0 = afterAll[0].filter(id => !beforeAll[0].includes(id));
    const newOn2 = afterAll[2].filter(id => !beforeAll[2].includes(id));
    const newOn3 = afterAll[3].filter(id => !beforeAll[3].includes(id));

    assert.ok(newOn0.includes(r0.entity_id), `pane 0 contains its new study ${r0.entity_id}`);
    assert.ok(newOn2.includes(r2.entity_id), `pane 2 contains its new study ${r2.entity_id}`);
    assert.ok(newOn3.includes(r3.entity_id), `pane 3 contains its new study ${r3.entity_id}`);

    // No cross-contamination.
    assert.ok(!newOn0.includes(r2.entity_id) && !newOn0.includes(r3.entity_id), 'pane 0 has no foreign new ids');
    assert.ok(!newOn2.includes(r0.entity_id) && !newOn2.includes(r3.entity_id), 'pane 2 has no foreign new ids');
    assert.ok(!newOn3.includes(r0.entity_id) && !newOn3.includes(r2.entity_id), 'pane 3 has no foreign new ids');
  });

  it('pane_focus moves activeChartIndex deterministically', async () => {
    for (const target of [2, 0, 3, 1]) {
      const r = await paneCore.focus({ index: target });
      assert.equal(r.success, true);
      assert.equal(r.focused_index, target);
      assert.equal(r.settled, true, `active index settled to ${target}`);
      const idxNow = await evaluate('window.TradingViewApi.activeChartIndex()');
      assert.equal(idxNow, target, `activeChartIndex is ${target}`);
    }
  });

  it('data_get_study_values reads from the requested pane', async () => {
    // Without pane_index it reads the active pane; with pane_index it reads that pane.
    for (let i = 0; i < 4; i++) {
      const v = await dataCore.getStudyValues({ pane_index: i });
      assert.equal(v.success, true, `study values returned for pane ${i}`);
      assert.ok(Array.isArray(v.studies), `studies array for pane ${i}`);
    }
  });

  it('indicator_set_inputs targets a specific pane', async () => {
    // Add a Moving Average to pane 1, then change its length via indicator_set_inputs(pane_index: 1).
    const added = await chartCore.manageIndicator({ action: 'add', indicator: 'Moving Average', pane_index: 1 });
    assert.equal(added.success, true, 'MA added on pane 1');
    const id = added.entity_id;

    const upd = await indicatorsCore.setInputs({ entity_id: id, inputs: { length: 33 }, pane_index: 1 });
    assert.equal(upd.success, true);
    assert.equal(upd.pane_index, 1, 'setInputs reports pane 1');
    assert.equal(upd.updated_inputs.length, 33, 'length input updated to 33');
  });
});
