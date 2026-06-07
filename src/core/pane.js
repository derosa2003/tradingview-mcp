/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var n = window.TradingViewApi.chartsCount();
      var panes = [];
      for (var i = 0; i < n; i++) {
        try {
          var api = window.TradingViewApi.chart(i);
          panes.push({ index: i, symbol: api.symbol(), resolution: api.resolution() });
        } catch(e) { panes.push({ index: i, error: e.message }); }
      }
      var activeIndex = window.TradingViewApi.activeChartIndex();

      return { layout: layoutType, chart_count: count, active_index: activeIndex, panes: panes };
    })()
  `);

  return {
    success: true,
    layout: result.layout,
    layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  const beforeCount = (await list()).chart_count;
  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  const shrank = typeof beforeCount === 'number' && state.chart_count < beforeCount;
  return {
    success: true,
    layout: resolved,
    layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
    ...(shrank ? { warning: `Layout shrank from ${beforeCount} to ${state.chart_count} panes — TradingView dropped the extra panes (their symbols/studies are gone from this layout). Save a layout first if you need them back.` } : {}),
  };
}

/**
 * Focus a specific pane by index.
 *
 * Uses `TradingViewApi.setActiveChart(N)` (an internal API call) instead of a
 * DOM click on the pane's main div, so focus is set deterministically without
 * depending on layout/visibility. Polls `activeChartIndex()` to confirm.
 */
export async function focus({ index }) {
  const idx = Math.floor(Number(index));
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`index must be a non-negative integer, got: ${index}`);

  const result = await evaluate(`
    (function() {
      var n = window.TradingViewApi.chartsCount();
      if (${idx} >= n) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + n + ' panes)' };
      window.TradingViewApi.setActiveChart(${idx});
      return { focused: ${idx}, total: n };
    })()
  `);
  if (result?.error) throw new Error(result.error);

  // Poll for active index to settle (the WatchedValue may update on the next tick)
  let settledIdx = -1;
  for (let i = 0; i < 20; i++) {
    settledIdx = await evaluate('window.TradingViewApi.activeChartIndex()');
    if (settledIdx === idx) break;
    await new Promise(r => setTimeout(r, 50));
  }

  return { success: true, focused_index: result.focused, total_panes: result.total, settled: settledIdx === idx };
}

/**
 * Set the symbol on a specific pane by index. Targets the pane directly via
 * `TradingViewApi.chart(N)` rather than relying on focus state.
 */
export async function setSymbol({ index, symbol }) {
  const idx = Math.floor(Number(index));
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`index must be a non-negative integer, got: ${index}`);

  await evaluateAsync(`
    (function() {
      var n = window.TradingViewApi.chartsCount();
      if (${idx} >= n) throw new Error('Pane index ${idx} out of range (have ' + n + ' panes)');
      var chart = window.TradingViewApi.chart(${idx});
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  // Read back to verify the symbol actually applied — previously fire-and-sleep
  // that returned success:true without confirming anything.
  const actual = await evaluate(`(function(){ try { return window.TradingViewApi.chart(${idx}).symbol(); } catch(e) { return null; } })()`);
  const norm = (x) => { const s = String(x ?? '').toUpperCase(); const i = s.indexOf(':'); return i >= 0 ? s.slice(i + 1) : s; };
  const applied = !!actual && norm(actual) === norm(symbol);
  return {
    success: applied,
    index: idx,
    symbol,
    actual_symbol: actual ?? null,
    ...(applied ? {} : { error: `Pane ${idx} symbol read back as "${actual}", not "${symbol}" — it may be invalid or still loading.` }),
  };
}
