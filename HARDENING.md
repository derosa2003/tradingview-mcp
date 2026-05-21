# MCP Hardening Backlog

> **What this is:** A prioritized list of reliability issues observed during a long real-world workspace-build session (2026-05-20 → 2026-05-21). Each item has observed behavior, root cause, proposed fix, JS API entry points found during investigation, and acceptance criteria.

> **How to use this doc:** Work the items in priority order. After completing each, mark the checkbox in this file and add a brief implementation note. Untouched items remain as backlog for future sessions. The findings here are based on a session that built 6 multi-pane layouts, ~100-symbol watchlist, and an Obsidian deliverable. Bugs surfaced under load, not in smoke tests.

> **Workflow:**
> 1. Pick the highest-priority unchecked item
> 2. Read its full spec + JS entry points
> 3. Implement, verify acceptance criteria, write tests
> 4. Check the box, add a note
> 5. Move to next

---

## Priority order

1. [x] **P0:** Explicit `pane_index` parameter on every chart operation (Finding #1)
2. [ ] **P0:** Silent layout save via `saveChartSilently` (Finding #2)
3. [ ] **P0:** Indicator Templates API (Finding #3)
4. [ ] **P1:** Compilation-verified indicator adds (Finding #4)
5. [ ] **P1:** Watchlist JS-API exposure (Finding #5)
6. [ ] **P2:** Chart-ready event awaiting (Finding #6)
7. [ ] **P2:** Authoritative state reads (no MCP caching) (Finding #7)
8. [ ] **P2:** Idempotent study removal (Finding #8)

---

## Finding #1 — Explicit `pane_index` on every chart operation

**Priority:** P0
**Observed behavior:**
- `pane_focus(1)` returns `{success: true, focused_index: 1}` but the next `chart_get_state()` returns data for pane 0 or 3 — not 1.
- `chart_manage_indicator` operations land on the wrong pane silently. During the session this caused indicators meant for pane 1 (TICK) to actually attach to pane 3 (VOLD), creating the appearance of "missing indicators on pane 1, doubled on pane 3" after layout save/load.
- Calling `cwc.activeChartWidget.setValue(...)` directly via `ui_evaluate` worked sometimes; other times `pane_list` continued to report `active_index: 0` no matter what.

**Root cause:**
TradingView has multiple "active" concepts (UI focus, the chartWidgetCollection's `_activeIndex`, the watched value `activeChartWidget`). These are not always in sync, especially right after a layout change or symbol set. The MCP relies on whichever one was last touched.

**Proposed fix:**
Every chart-pane operation should accept an explicit `pane_index` parameter. Internally:
1. Call `chartWidgetCollection.activeChartWidget.setValue(cwc._chartWidgetsDefs[pane_index].chartWidget)`
2. Subscribe to `cwc._activeIndex` watched value and wait for it to settle to the requested index (with a 2s timeout)
3. Execute the operation
4. Restore previous active index if desired

**Tools to modify:**
- `chart_get_state` — add `pane_index` param (default current active)
- `chart_set_timeframe` — add `pane_index` param
- `chart_set_symbol` — already has it (verify it works correctly)
- `chart_manage_indicator` — add `pane_index` param
- `indicator_set_inputs` — add `pane_index` param
- `data_get_*` family — add `pane_index` param

**JS API entry points found:**
```js
const cwc = window.TradingViewApi._chartWidgetCollection;
const defs = cwc._chartWidgetsDefs;            // array of chart widget definitions
cwc.activeChartWidget.setValue(defs[i].chartWidget);  // imperatively set active
cwc._activeIndex                                       // current active index (number)
cwc.activeChartWidget.subscribe(cb)                    // watched-value subscription
```

**Acceptance criteria:**
- Round-trip test: in a 4-pane layout, for each of the 4 panes:
  1. Add a Volume study via MCP with `pane_index: N`
  2. Read state via `chart_get_state(pane_index: N)`
  3. Assert exactly one Volume study appears
  4. Assert other 3 panes have zero new studies
- Test with rapid sequential operations across different pane indices to verify no race conditions

**Implementation note (2026-05-21):**
Discovered that `TradingViewApi.chart(N)` exposes a per-pane chart API directly (same shape as `_activeChartWidgetWV.value()` but addressing a specific pane regardless of focus). Added `chartApiExpr(pane_index)` / `chartWidgetExpr` / `barsExpr` helpers in `connection.js` and threaded an optional `pane_index` through `chart_get_state`, `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`, `chart_manage_indicator`, `indicator_set_inputs`, `indicator_toggle_visibility`, `data_get_ohlcv`, `data_get_indicator`, `quote_get`, `data_get_study_values`, and all four `data_get_pine_*` tools. `pane_focus` now uses `setActiveChart(N)` + a polled `activeChartIndex()` settle check instead of a DOM click on the pane's main div. Backwards-compatible: omitting `pane_index` preserves "current active pane" behavior. Tests in `tests/pane_index.test.js` set up a 4-pane layout and verify per-pane targeting plus the rapid sequential acceptance criterion — all 7 pass against live TV.

---

## Finding #2 — Silent layout save (no dialog)

**Priority:** P0
**Observed behavior:**
- `saveChartAs()` opens a "Make a copy" dialog. The MCP tried to programmatically fill the name input + click the button, but the click did not reliably trigger React's submit handler. Most attempts ended with the dialog closing but no new layout created.
- Subsequent reliance on user manual "Make a copy" was error-prone (user accidentally hit Ctrl+S = overwrite, twice).

**Root cause:**
React-controlled inputs require specific synthetic event sequences (`input`, `change`, sometimes `keydown`/`keyup` with valid `data` field). Setting `.value` directly bypasses React's internal state. Clicking the submit button doesn't actually submit because React thinks the input is empty.

**Proposed fix:**
Use the internal `_chartSaver.saveChartSilently()` API directly, with proper layoutId management to create a NEW layout (not overwrite the current one).

**JS API entry points found:**
```js
const ss = window.TradingViewApi._saveChartService;
const chartSaver = ss._chartSaver;

// Silent save with options
await new Promise((resolve, reject) =>
  chartSaver.saveChartSilently(
    (result) => resolve(result),  // {uid, data}
    () => reject(new Error('save failed')),
    { chartName: 'NEW_NAME', autoSave: false }
  )
);

// To force CREATE NEW vs OVERWRITE, clear layoutId before:
// ss._chartWidgetCollection.metaInfo.id.setValue(null)  // — verify safety
```

**New tool to add:**
```
layout_save_as(name: string, on_conflict: "error" | "overwrite") -> {layout_id, name}
```

**Acceptance criteria:**
- Calling `layout_save_as("MyTest")` creates a new layout, returns its id, leaves the previously-saved layout untouched
- `on_conflict: "error"` returns an error if a layout with that name already exists
- `on_conflict: "overwrite"` replaces the existing same-named layout
- No dialogs appear during the operation

---

## Finding #3 — Indicator Templates API

**Priority:** P0
**Observed behavior:**
The session needed 6 indicator templates (`Trend Stack`, `Trend No-Vol`, `Weinstein Stack`, `Intraday Research`, `Intraday Price`, `Intraday Internal`). Without an API, the user had to manually save and apply each template 20+ times via TV's UI. The MCP repeatedly added the same indicators per pane instead, which is wasteful and accumulated duplicates and Pine parse errors.

**Root cause:**
TV has a fully-featured Indicator Templates system natively, but it's not exposed in the MCP at all.

**Proposed fix:**
Find the templates API in webpack chunks and wrap it. Likely lives under `studyTemplatesDrawer` or similar (seen in earlier API probe: `_studyTemplatesDrawer` on `TradingViewApi`).

**New tools to add:**
```
indicator_template_list() -> {templates: [{name, study_count}, ...]}
indicator_template_save(name: string, pane_index?: number, save_chart_properties?: bool) -> {success}
indicator_template_apply(name: string, pane_index?: number) -> {studies_added: [{id, name}, ...]}
indicator_template_delete(name: string) -> {success}
```

**JS API entry points to investigate:**
```js
window.TradingViewApi._studyTemplatesDrawer  // probably wraps the templates UI
// Also likely accessible via:
window.TradingViewApi._activeChartWidgetWV.value().activeChart()
  // .someTemplateAPI?
```
Dig the webpack chunks for `applyStudyTemplate` or similar.

**Acceptance criteria:**
- Save template from pane → list shows it → apply to different pane → state has the same studies with same inputs
- Templates persist across sessions (saved server-side)
- Save / apply / delete operations are idempotent
- Applying a template to a pane that already has studies adds the template's studies (doesn't replace) — or has an explicit `replace: bool` flag

---

## Finding #4 — Compilation-verified indicator add

**Priority:** P1
**Observed behavior:**
Built-in indicators (`Moving Average Exponential`, `Moving Average`) added via `chart_manage_indicator` with `inputs: '{"length": 9}'` succeeded according to the MCP return, but rendered as `⚠ Can't parse pine` errors on the chart. The studies were "attached" in the entity list but didn't compute. Removing + manually adding via TV's UI produced clean working indicators.

**Root cause:**
The MCP's inputs serialization or the way it passes them through `chartApi.createStudy(...)` produces a Pine script invocation that the engine can't compile. Possibly bad JSON escape, possibly wrong key names for the indicator metadata.

**Proposed fix:**
1. After `chart_manage_indicator add`, poll the study's compilation status for up to 1s
2. If compilation failed, automatically retry: add without `inputs`, then call `indicator_set_inputs` separately
3. If still failed, remove the broken study and return `{success: false, error: "compilation_failed", details: "..."}`
4. Never return `{success: true}` with a study that's actually showing ⚠ on the chart

**JS API entry points:**
```js
// After adding, get the study object:
const studies = activeChart.getAllStudies();
const study = studies.find(s => s.id === entity_id);
// Compilation status — investigate:
study._isReady, study._error, study._lastError, study._sources
// Or watch for the "ready" event before declaring success
```

**Acceptance criteria:**
- Adding any built-in indicator with inputs returns either `{success: true, compilation_status: "ok"}` or `{success: false, error: "..."}`
- No silent ⚠ studies left attached to charts
- Smoke test: add EMA(9), EMA(20), SMA(50), SMA(200), Volume, VWAP on a fresh pane, all should compile clean

---

## Finding #5 — Watchlist JS-API exposure

**Priority:** P1
**Observed behavior:**
`watchlist_add(symbol)` returned `"Button not found for panel: watchlist"` even when the watchlist sidebar was visible and `MARKET MONITOR` was the active list. The user was forced to paste ~100 symbols manually as CSV into TV's `+ Add symbol` field. The MCP was effectively useless for watchlist population.

**Root cause:**
`watchlist_add` clicks the "+ Add symbol" button in the widget bar, then types a symbol. If the button isn't in the visible DOM (sidebar hidden, panel resized, etc.), the click fails. The MCP doesn't have a JS-API path to the watchlist data layer.

**Proposed fix:**
Find the watchlist module via webpack and expose data-layer operations directly. The active watchlist id is accessible via:
```js
window.TVD.getActiveWatchlistId()  // returns active watchlist {} or id
window.TVD.onActiveWatchlistIdChange(cb)  // subscribe to changes
```
Dig further into how symbols are added programmatically.

**New tools to add:**
```
watchlist_list() -> {watchlists: [{id, name, symbol_count}, ...]}
watchlist_create(name: string) -> {id}
watchlist_delete(name_or_id: string) -> {success}
watchlist_set_active(name_or_id: string) -> {success}
watchlist_get_active() -> {id, name, symbols: [...]}
watchlist_add_batch(symbols: string[], watchlist?: string) -> {added: [...], failed: [...]}
watchlist_remove(symbol: string, watchlist?: string) -> {success}
watchlist_add_section(name: string, position?: number) -> {success}
```

**Acceptance criteria:**
- Create a new watchlist programmatically, populate with 50 symbols in batch, verify state, delete — all without any UI interactions
- Works whether the watchlist sidebar is open or closed
- Section dividers can be added between symbols and persist
- Switching active watchlist updates the active state without dialog/prompt

---

## Finding #6 — Chart-ready event awaiting

**Priority:** P2
**Observed behavior:**
After `chart_set_symbol` or `chart_set_timeframe`, the next operation often hit stale state. Example: change pane 0 to TICK on 5m, then immediately `chart_get_state` returns the previous symbol or resolution. Race window of ~200-800ms.

**Root cause:**
TV's chart loading is asynchronous. Symbol changes trigger a network fetch for OHLCV data. The MCP returns success when the *intent* is set, not when the data is loaded.

**Proposed fix:**
Add internal `await chartReady()` waits to all chart-mutating operations. Surface a `chart_wait_ready(pane_index?)` tool for explicit use.

**JS API entry points to investigate:**
```js
const chart = activeChartWidget.activeChart();
// Look for: chart._dataReady, chart.onDataLoaded, chart.symbolStatus
// Or watch for the `chartReady` event on the widget
chart.onChartReady(cb)  // if exists
```

**Acceptance criteria:**
- `chart_set_symbol` returns only after the new symbol's data is loaded and visible
- Sequential operations (change symbol, change TF, add study) execute against the new state, not the previous
- Test: rapidly change symbol → set TF → add study → get state, verify all reflect new state

---

## Finding #7 — Authoritative state reads (no MCP caching)

**Priority:** P2
**Observed behavior:**
`layout_list` returned stale data — sometimes 3 layouts when there were really 5; sometimes the right count but old names. Multiple `ui_evaluate` calls were needed mid-session to force a refresh via `_loadChartService.refreshChartList()`.

**Root cause:**
The MCP appears to cache `layout_list` results. Cache invalidation is broken or absent.

**Proposed fix:**
Either:
1. Remove caching entirely — read from `window.TradingViewApi._loadChartService._state.value()` on every call
2. Auto-invalidate cache on any layout mutation (delete, save_as, create)

**JS API entry points:**
```js
window.TradingViewApi._loadChartService._state.value()  // authoritative state
// .chartList — array of {id, url, name, symbol, interval, modified, ...}

await window.TradingViewApi._loadChartService.refreshChartList()  // force refresh
```

**Acceptance criteria:**
- After deleting a layout via MCP, `layout_list` immediately reflects the deletion
- After creating a layout via MCP, `layout_list` immediately includes it
- No stale reads observed across 10 rapid mutation+read cycles

---

## Finding #8 — Idempotent study removal

**Priority:** P2
**Observed behavior:**
Calling `chart_manage_indicator remove` with `entity_id: "QR9Ri4"` returned success, but the same study id appeared in `chart_get_state` of another pane afterwards. Suggests:
1. The removal didn't fully delete the study from the chart widget collection, OR
2. The study was shared across panes (which itself is unexpected), OR
3. State reads are returning aggregate state from multiple panes

**Root cause:**
Most likely combined with Finding #1 (wrong pane targeting). When pane targeting works correctly, this may resolve. But also worth verifying that removals actually clear the study from the underlying chart data structure, not just hide it.

**Proposed fix:**
After `remove`, verify the entity_id no longer exists anywhere in the layout's full study list. If it does, the remove failed silently.

**Acceptance criteria:**
- Remove an indicator from pane N
- `chart_get_state(pane_index: N)` shows it gone
- All other panes (0..M, M≠N) also show it gone (since it was attached to pane N only)
- Idempotency: calling remove twice on the same entity_id returns success the second time (no-op), not an error

---

## Implementation notes

### Suggested order
The P0 items (#1, #2, #3) unlock the largest workflow improvements. Implement and test them in order; each builds on the previous (pane indexing → silent save → templates).

### Test strategy
Each finding has acceptance criteria above. Run them as integration tests against a live TradingView Desktop instance via CDP. Smoke tests should at minimum:
1. Build a 4-pane layout via MCP
2. Add 4 different indicators across panes (one per pane)
3. Save as new layout via `layout_save_as`
4. Apply a saved template to all 4 panes
5. Verify final state matches spec
6. Clean up (delete the test layout)

### Backwards compatibility
Existing tools should keep working with their current signatures (default `pane_index` to current active). Add new tools rather than break old ones.

---

## Session reference

This backlog was generated from a session that built:
- 6 chart layouts (Macro, Volume, Intra Pulse, Topdown, Vert View, Sectors-RS)
- A ~100-symbol consolidated watchlist with section dividers
- A 7,700-word Obsidian companion doc

The friction during that build is what surfaces in this backlog. Real workflows revealed real bugs.

---

*Generated: 2026-05-21 · Generated by Claude (sonnet) at the user's request following the workspace build session.*
