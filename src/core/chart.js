/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite, chartApiExpr } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

export async function getState({ pane_index, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const expr = chartApiExpr(pane_index);
  const state = await evaluate(`
    (function() {
      var chart = ${expr};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, pane_index: pane_index ?? null, ...state };
}

export async function setSymbol({ symbol, pane_index, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const expr = chartApiExpr(pane_index);
  await evaluateAsync(`
    (function() {
      var chart = ${expr};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 200);
      });
    })()
  `);
  // Use the per-pane dataReady() poll regardless of which pane we hit — it
  // reads the chart API directly, not the DOM, so it's accurate for any pane.
  const r = await waitReady({ pane_index, timeout_ms: 8000, _deps });
  return { success: true, symbol, pane_index: pane_index ?? null, chart_ready: r.ready, waited_ms: r.waited_ms ?? null };
}

export async function setTimeframe({ timeframe, pane_index, _deps }) {
  const { evaluate } = _resolve(_deps);
  const expr = chartApiExpr(pane_index);
  await evaluate(`
    (function() {
      var chart = ${expr};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const r = await waitReady({ pane_index, timeout_ms: 8000, _deps });
  return { success: true, timeframe, pane_index: pane_index ?? null, chart_ready: r.ready, waited_ms: r.waited_ms ?? null };}

export async function setType({ chart_type, pane_index, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  const expr = chartApiExpr(pane_index);
  await evaluate(`
    (function() {
      var chart = ${expr};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum, pane_index: pane_index ?? null };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, pane_index, _deps }) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  const expr = chartApiExpr(pane_index);

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${expr}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${expr};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);

    // Wait for the new study to land, then verify compilation. Poll up to 3s.
    let newId = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const after = await evaluate(`${expr}.getAllStudies().map(function(s) { return s.id; })`);
      const newIds = (after || []).filter(id => !(before || []).includes(id));
      if (newIds.length > 0) { newId = newIds[newIds.length - 1]; break; }
    }
    if (!newId) {
      return { success: false, action: 'add', indicator, error: 'Study did not appear after createStudy. The indicator name may be wrong, or it failed to compile.', pane_index: pane_index ?? null };
    }

    // Check compilation status — Pine compile errors show a ⚠ on the study and
    // `hasError`/`isPine`/`hasCompileError` flags reflect that.
    const status = await evaluate(`
      (function(){
        var chart = ${expr};
        var failed = chart.compileFailedStudies();
        var thisFailed = false;
        try {
          for (var i = 0; i < failed.length; i++) {
            if (failed[i].id() === ${safeString(newId)} || failed[i].id === ${safeString(newId)}) { thisFailed = true; break; }
          }
        } catch(e) {}
        var study;
        try { study = chart.getStudyById(${safeString(newId)}); } catch(e) { study = null; }
        var hasErr = false;
        try { if (study && typeof study.hasError === 'function') hasErr = !!study.hasError(); } catch(e) {}
        return { compile_failed: thisFailed, has_error: hasErr };
      })()
    `);

    if (status.compile_failed || status.has_error) {
      // Auto-recover: try removing the bad study and re-adding without input overrides.
      // Bad input JSON is the most common cause of a silent compile failure.
      let retryId = null;
      if (inputArr.length > 0) {
        try {
          await evaluate(`${expr}.removeEntity(${safeString(newId)})`);
          await new Promise(r => setTimeout(r, 300));
          const before2 = await evaluate(`${expr}.getAllStudies().map(function(s) { return s.id; })`);
          await evaluate(`${expr}.createStudy(${safeString(indicator)}, false, false, [])`);
          await new Promise(r => setTimeout(r, 1200));
          const after2 = await evaluate(`${expr}.getAllStudies().map(function(s) { return s.id; })`);
          const newIds2 = (after2 || []).filter(id => !(before2 || []).includes(id));
          retryId = newIds2[newIds2.length - 1] || null;
          if (retryId) {
            // Try to set inputs via setInputs (which goes through study.setInputValues — different path than createStudy)
            const inputsJson = JSON.stringify(inputs);
            await evaluate(`
              (function(){
                var st = ${expr}.getStudyById(${safeString(retryId)});
                if (!st) return;
                var cur = st.getInputValues();
                var ovr = ${inputsJson};
                for (var i = 0; i < cur.length; i++) {
                  if (Object.prototype.hasOwnProperty.call(ovr, cur[i].id)) cur[i].value = ovr[cur[i].id];
                }
                st.setInputValues(cur);
              })()
            `);
            await new Promise(r => setTimeout(r, 500));
            // Re-check compilation
            const status2 = await evaluate(`
              (function(){
                var chart = ${expr};
                var failed = chart.compileFailedStudies();
                var thisFailed = false;
                try { for (var i = 0; i < failed.length; i++) { var fid = (typeof failed[i].id === 'function') ? failed[i].id() : failed[i].id; if (fid === ${safeString(retryId)}) { thisFailed = true; break; } } } catch(e) {}
                return { compile_failed: thisFailed };
              })()
            `);
            if (!status2.compile_failed) {
              return { success: true, action: 'add', indicator, entity_id: retryId, compilation_status: 'ok', pane_index: pane_index ?? null, recovered: true, note: 'Initial add failed compile; recovered by adding without inputs then setting inputs via setInputs.' };
            }
            // Still failed — remove and report
            try { await evaluate(`${expr}.removeEntity(${safeString(retryId)})`); } catch {}
          }
        } catch (e) {
          // fall through to error report
        }
      } else {
        // No inputs to blame — remove the broken study and report
        try { await evaluate(`${expr}.removeEntity(${safeString(newId)})`); } catch {}
      }
      return {
        success: false,
        action: 'add',
        indicator,
        error: 'compilation_failed',
        details: 'Study attached but failed to compile (⚠ on chart). Removed automatically.',
        pane_index: pane_index ?? null,
      };
    }

    return { success: true, action: 'add', indicator, entity_id: newId, new_study_count: 1, compilation_status: 'ok', pane_index: pane_index ?? null };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');

    // Idempotent: if the study isn't in any pane, return success with already_removed=true.
    const findResult = await evaluate(`
      (function(){
        ${pane_index === undefined || pane_index === null
          ? `var n = window.TradingViewApi.chartsCount();
             for (var i = 0; i < n; i++) {
               try { var s = window.TradingViewApi.chart(i).getStudyById(${safeString(entity_id)}); if (s) return { found: true, pane_index: i }; } catch(e) {}
             }
             return { found: false };`
          : `var s = null;
             try { s = ${expr}.getStudyById(${safeString(entity_id)}); } catch(e) {}
             return s ? { found: true, pane_index: ${Number(pane_index)} } : { found: false };`}
      })()
    `);

    if (!findResult.found) {
      return { success: true, action: 'remove', entity_id, already_removed: true, pane_index: pane_index ?? null };
    }

    const removeExpr = chartApiExpr(findResult.pane_index);
    await evaluate(`
      (function() {
        var chart = ${removeExpr};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);

    // Verify removal — read back from all panes
    const stillThere = await evaluate(`
      (function(){
        var n = window.TradingViewApi.chartsCount();
        for (var i = 0; i < n; i++) {
          try { if (window.TradingViewApi.chart(i).getStudyById(${safeString(entity_id)})) return true; } catch(e) {}
        }
        return false;
      })()
    `);

    if (stillThere) {
      return { success: false, action: 'remove', entity_id, error: 'remove_failed', details: 'Study still present after removeEntity', pane_index: findResult.pane_index };
    }

    return { success: true, action: 'remove', entity_id, pane_index: findResult.pane_index };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

/**
 * Wait for the chart at pane_index to finish loading data after a symbol /
 * resolution change. Resolves when mainSeries data is non-empty or the
 * timeout elapses. Surfaces a `ready` boolean.
 */
export async function waitReady({ pane_index, timeout_ms = 8000, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const expr = chartApiExpr(pane_index);
  const start = Date.now();
  let lastSym = null, lastRes = null;
  while (Date.now() - start < timeout_ms) {
    const state = await evaluate(`
      (function(){
        var c = ${expr};
        var ready = false;
        try { ready = c.dataReady(); } catch(e) {}
        var sym = null, res = null;
        try { sym = c.symbol(); res = c.resolution(); } catch(e) {}
        return { ready: !!ready, symbol: sym, resolution: res };
      })()
    `);
    lastSym = state.symbol; lastRes = state.resolution;
    if (state.ready) {
      return { success: true, ready: true, pane_index: pane_index ?? null, symbol: lastSym, resolution: lastRes, waited_ms: Date.now() - start };
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return { success: false, ready: false, pane_index: pane_index ?? null, symbol: lastSym, resolution: lastRes, timeout_ms, error: 'dataReady never became true within timeout' };
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
