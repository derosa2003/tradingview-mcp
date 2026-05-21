# TradingView MCP — Phase 3 Priorities

Phase 2 (2026-05-20) validated the native tool surface against
TradingView Desktop 3.1.0 on pinned commit `b2e07fa`. Phase 3's focus
shifts from validation to **custom-code additions**, with a small audit
pass in front to clear the bugs Phase 2 surfaced.

See `WORKING.md` for the Phase 2 validation matrix and `KNOWN_ISSUES.md`
for the detailed findings each Phase 3 item is responding to.

## Tier-zero — trivial in-source fixes (no probing needed)

1. **`drawing.js` import bug.** Four functions — `listDrawings`,
   `getProperties`, `removeOne`, `clearAll` — reference bare
   `getChartApi` instead of resolving via `_resolve(_deps)`. All hard-
   fail in production with `getChartApi is not defined`, yet unit tests
   report them passing (the e2e suite injects `getChartApi` via
   `_deps`, masking the bug). Fix is ~4 lines + an integration test
   that exercises the production code path.

## Audit pass — TVDesktop 3.1.0 surface refresh

2. **DOM selector audit.** Probe every panel selector in
   `src/core/ui.js` against the live DOM, replace stale entries, add
   fallback chains, document the canonical reference build. Concrete
   targets already identified by Phase 2:

   - `watchlist`: both `[data-name="base-watchlist-widget-button"]` and
     `[aria-label="Watchlist"]` are stale. Real aria-label is
     `"Watchlist, details, and news"`.
   - `alerts`: `[data-name="alerts-button"]` stale; `[aria-label="Alerts"]`
     live; `[data-name="alerts"]` exists as a modern alternative.
   - `alert_create` inputs: `[class*="alert"] input[type="text|number"]`
     don't match the alert dialog DOM — probe live to find the current
     classes.
   - `pine_smart_compile` buttons: "Add to chart" / "Update on chart"
     selectors don't match — tool always falls through to "Pine Save".
   - `trading` panel: untested in Phase 2.

3. **JS-API audit (companion to #2).** `typeof bwb.someMethod ===
   'function'` returns true even for stub/no-op prototype methods.
   Phase 2 was misled by this on the Pine Editor open path:
   `activateScriptEditorTab` and `showWidget` registered as functions
   but did nothing. Working methods on TVDesktop 3.1.0 are `bwb.open()`
   and `bwb.show('pine-editor')`. Audit methodology must verify a live-
   action DOM side effect after invocation, not just `typeof`. Also
   surfaced: `bwb.hideWidget` is missing entirely — the npm test suite
   already flags this in `ui_open_panel — open/close pine-editor`.

4. **`pine_smart_compile` button-selector refresh.** Update the button-
   text patterns and add a click-then-verify on `getAllStudies()` count
   to match the diagnostic pattern from `b2e07fa`. Goal: `study_added`
   accurately reflects whether the chart actually picked up the
   compiled study.

5. **`alert_delete_by_id` tool.** The current `alert_delete` is
   delete-all-only — no `id` / `entity_id` parameter — which blocks the
   "create one alert, delete that alert" workflow and risks destroying
   user data. Design a per-alert delete. Pair with item #2's alerts-
   dialog selector work so the full lifecycle unblocks together.

## Custom-code additions

These are the Phase 3 product features — new tools in our own code,
not refactors of native validation.

6. **Paper trading position tracker.** Custom tool layer on top of the
   chart's replay + trade events; track simulated positions, P&L, basis
   per symbol. Likely lives in a new `src/core/positions.js`. Depends
   on stable `replay_*` tool behavior, which Phase 2 didn't validate —
   add a small validation pass before designing.

7. **Trade journaling.** Persistent record of trades (paper or live
   from the replay tools) with annotations, screenshots,
   tags. Cross-references `capture_screenshot` for visual capture —
   that path is already validated in Phase 2.

8. **Risk math / position sizing.** Pure-function helpers (no chart
   dependency) — Kelly, fixed-fractional, R-multiple, fixed-risk
   sizing. Inputs: account size, stop distance, risk %. Easy to land,
   pairs well with paper trading + journaling. Probably belongs in
   `src/core/risk.js` with thorough unit tests.

9. **Order book snapshot tool (research feasibility first).** The
   existing `depth_get` tool fails on most symbols because the DOM
   panel isn't open. Research whether TradingView exposes a reliable
   internal API for the order book or whether this is panel-only. If
   it's a real ceiling, document and de-scope.

## Deferred — revisit when prioritized

10. **`tab_new` / `Cmd+T` workaround.** Phase 1 found CDP
    `dispatchKeyEvent` doesn't reach Electron's main-process menu
    handler, so app-level shortcuts don't fire. Phase 2's `b2e07fa`
    patch made the failure honest. Options for an eventual fix:
    `Target.createTarget` via CDP, or a DOM `+`-button selector if the
    tab-strip exposes one. Phase 2 explicitly deferred this; revisit
    only when a workflow actually needs multi-tab.
