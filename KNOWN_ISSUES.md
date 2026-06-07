# TradingView MCP — Phase 1: Known Issues

Validated 2026-05-20 against TradingView Desktop 3.1.0 on macOS.
Pinned commit 4795784a19dd64ff4e2649d2499a536b01bd2d68.

## `tab_new` — returns success but no tab is created

- Input: `{}` (no parameters)
- Response (verbatim):

  ```json
  {
    "success": true,
    "action": "new_tab_opened",
    "tab_count": 1,
    "tabs": [
      {
        "index": 0,
        "id": "F07D23E25389BEC62D59FD29005841D7",
        "title": "TradingView",
        "url": "https://www.tradingview.com/chart/2Zw8YoqT/",
        "chart_id": "2Zw8YoqT"
      }
    ]
  }
  ```

- Confirmed with an immediate `tab_list` call: still 1 tab, same id.
  No new tab appeared in the TradingView window either.
- Hypothesis: the CDP/UI action the server fires for "new tab" is not
  reaching TradingView Desktop 3.1.0's tab strip — possibly an
  Electron-version or keyboard-shortcut mismatch — yet the server
  returns success without verifying the post-state.
- Downstream impact: `tab_switch` and `tab_close` could not be
  exercised against a fresh tab (closing the only tab would have
  destroyed the user's chart session). Both SKIPPED in this round.
- Why this matters: silent success is worse than honest failure. A
  caller that chains `tab_new` → `tab_close` to discard a throwaway
  tab will instead close the user's only real tab. The response
  already includes a re-queried `tab_count`, so the server has the
  information needed to detect this — it just doesn't assert on it.
- Suggested direction (not pursued — pin held): capture `tab_count`
  before the action, re-query after, and only return `success: true`
  if it increased. The broader concern this raises is whether other
  state-mutating tools have the same "return success without
  verifying the side-effect landed" pattern — worth a Phase 2 audit
  pass across the surface.

## `watchlist_add` — patch-verified, end-to-end blocked on openPanel selector regression (Phase 2, post-b2e07fa)

**Phase 1 finding (superseded):** With the watchlist panel closed, `watchlist_add`
returned `success: false` with error "Add symbol button not found in watchlist
panel" — no automatic open-then-add fallback.

**b2e07fa patch:** Now routes through canonical `openPanel({ panel: 'watchlist',
action: 'open' })` before clicking the add-symbol button (see
`src/core/watchlist.js:70`). Phase 2 confirms the routing patch behaves
correctly — when `openPanel` fails, the failure propagates honestly via
`throw`, no silent success.

**Phase 2 finding (new):** `openPanel`'s watchlist branch
(`src/core/ui.js:62`) has stale DOM selectors for TVDesktop 3.1.0. Live DOM
probe (2026-05-20):

| Selector in `selectorMap.watchlist` | Status on TVDesktop 3.1.0 |
|---|---|
| `[data-name="base-watchlist-widget-button"]` | **NOT FOUND** |
| `[aria-label="Watchlist"]` | **NOT FOUND** |

The actual aria-label on the unified right-sidebar button in this build is
`"Watchlist, details, and news"` (not `"Watchlist"` alone).

**Status:** `watchlist_add` is **patch-verified, end-to-end blocked on
openPanel selector regression**. Not a fire-and-trust instance — failure
is surfaced honestly. Deferred to Phase 3 selector audit.

## openPanel selector rot (general) — Phase 2 finding

Live DOM probe (2026-05-20, TVDesktop 3.1.0) found that
`selectorMap` in `src/core/ui.js:62-66` has at least one stale entry
in each panel checked. Currently the OR-fallback structure
(`[data-name=...] || [aria-label=...]`) means panels still work when *one*
of the two paths is live, but the surface is degrading:

| Panel | Selector | Status |
|---|---|---|
| `watchlist` | `[data-name="base-watchlist-widget-button"]` | STALE |
| `watchlist` | `[aria-label="Watchlist"]` | STALE — only `"Watchlist, details, and news"` exists |
| `alerts` | `[data-name="alerts-button"]` | STALE — modern data-name appears to be `[data-name="alerts"]` |
| `alerts` | `[aria-label="Alerts"]` | LIVE ✅ |
| `trading` | — | untested in Phase 2 |

Pine editor's bottom-panel branch uses `window.TradingView.bottomWidgetBar`
JS API rather than DOM selectors. `bottomWidgetBar`, `activateScriptEditorTab`,
and `showWidget` are all present, but `hideWidget` is **missing** on this
build — so `openPanel({panel: 'pine-editor', action: 'close'})` will
silently no-op. Open actions work fine.

> **Sub-note:** Pine Editor `bwb.hideWidget` method missing on TVDesktop 3.1.0
> — only affects programmatic close path; open path verified live. Anything
> calling `ui_close_panel` or equivalent for `pine-editor` will silently fail.

Phase 3 work: full DOM selector audit pass against TVDesktop 3.1.0 — see
`NEXT_STEPS.md`.

## Schema / field-name clarifications

- `chart_manage_indicator` (action `add`) returns `new_study_count`, which
  appears to mean **"studies added by this call"** (typically `1`), not
  total studies on the chart. Phase 2 round-trip confirmed: pre-add state
  had 1 study (Volume), `add MACD` returned `new_study_count: 1`, and
  follow-up `chart_get_state` showed both Volume and MACD present. Use
  `chart_get_state.studies.length` if you need the post-add total.

## Alerts tier — Phase 2 findings

### `alert_create` — selector rot, honest failure

- Input: `{ condition: "crossing", price: 65.78, message: "..." }`
- Response: `{ success: false, price_set: false, source: "dom_fallback" }`
- Failure mode: same class as `watchlist_add` — DOM selectors in
  `src/core/alerts.js` (`[class*="alert"] input[type="text"]` and
  `[class*="alert"] input[type="number"]`) don't match the alert dialog
  DOM on TVDesktop 3.1.0, so price input could not be located.
- **Not fire-and-trust** — failure is surfaced honestly via
  `success: false` and the diagnostic `price_set` field.
- Post-state verified: `alert_list` still shows 0 alerts → no partial
  alert created.
- Defer to Phase 3 selector audit alongside `watchlist_add`.

### `alert_delete` — delete-all-only, schema-level gap

- Schema accepts only `delete_all: boolean`. No `id` / `entity_id` /
  `alert_id` parameter.
- Cannot delete a specific alert; must wipe all alerts in the account.
- Phase 2 validation attempted `delete_all: true` (after `alert_create`
  honestly failed, so there was no alert to clean up); the permission
  guardrail correctly refused the destructive call to protect any
  pre-existing alerts that might have been in the account.
- This is a **tool-design gap**, not a selector or fire-and-trust issue.
  The "create one alert, delete that alert" validation pattern requires
  a per-alert delete that does not exist.
- See `NEXT_STEPS.md` Phase 3 item for the proposed
  `alert_delete_by_id` tool design.

### `alert_list` — renderer-side network call

- Reads via a **browser-context** `fetch` to
  `https://pricealerts.tradingview.com/list_alerts` with
  `credentials: 'include'`.
- This is **not a Node-side credentialed call** — it runs inside the
  TradingView page via CDP `evaluate`, using the user's existing browser
  session. Functionally equivalent to what the TradingView UI itself
  does.
- Does **not** violate the relaxed Phase 2 network rule (which only
  restricts Node-side credentialed calls).
- Worth noting alongside `pine_check`'s Node-side anonymous fetch as a
  distinct network category — "renderer-side, user-session" — so future
  audits can categorize new network calls correctly:

| Category | Where | Sends credentials? | Example tool |
|---|---|---|---|
| Renderer-side, user-session | inside TV page via CDP `evaluate` | yes (user's own cookies) | `alert_list`, `pine_list_scripts`, `pine_open` |
| Node-side, anonymous | MCP server process, native `fetch` | no (Referer/Origin only) | `pine_check` |
| Node-side, credentialed | MCP server process, native `fetch` | yes | **forbidden** by relaxed Phase 2 rule |

## Drawing tier — Phase 2 findings

### In-source bug: `getChartApi is not defined` in 4 drawing functions

`src/core/drawing.js` imports `getChartApi as _getChartApi` (line 4) and
exposes it via `_resolve(deps)` (lines 6-8) so it can be dependency-injected
for tests. Only `drawShape` (line 11) actually calls `_resolve(_deps)` to
bind it. The other four functions — `listDrawings` (line 48),
`getProperties` (line 60), `removeOne` (line 89), and `clearAll` (line 110)
— reference bare `getChartApi`, which is undefined in their scope.

Symptom (verified Phase 2):
```
{ "success": false, "error": "getChartApi is not defined" }
```

Affects tools `draw_list`, `draw_get_properties`, `draw_remove_one`,
`draw_clear`. Trivially fixable by adding `const { evaluate, getChartApi }
= _resolve(_deps);` at the top of each affected function. **First Phase 2
finding that is a JS-level bug in our own code**, not a TVDesktop
version-drift / selector-rot issue. Should be tier-zero priority for
Phase 3 since it requires no external probing.

### `draw_shape` works and has good hygiene already

`draw_shape` captures `getAllShapes()` IDs before the create, captures
after, computes new ID via set diff (lines 20, 41-42 in
`src/core/drawing.js`). This is the **pattern other drawing tools should
follow** when patched. Phase 2 verification: `draw_shape` returned
`entity_id: "Ab0R9Q"`; direct chart-API probe confirmed the shape was
actually present in `chart.getAllShapes()`. Not fire-and-trust.

### Pre-existing user drawings observed

The chart had a pre-existing `trend_line` shape (`FHHECU`) before any
Phase 2 drawing work. Phase 2 validation respected it — manual cleanup
of the Phase 2 horizontal_line was done via `chart.removeEntity('Ab0R9Q')`
to avoid disturbing the pre-existing shape. `draw_clear` was not
exercised in Phase 2 for the same protective reason.

## `npm test` — Phase 2 one-off result

Run 2026-05-20. Single deterministic failure plus one cancellation
after a long hang. Output captured at `/tmp/phase2_npm_test.log`
during validation.

```
ℹ tests 68
ℹ suites 7
ℹ pass 66
ℹ fail 1
ℹ cancelled 1
ℹ skipped 0
```

### Single deterministic failure

```
test at tests/e2e.test.js:1032:5
✖ ui_open_panel — open/close pine-editor (504.659333ms)
  Error: TypeError: window.TradingView.bottomWidgetBar.hideWidget is not a function
```

This is the same `hideWidget` missing-method finding that Phase 2 live
probing surfaced (see openPanel selector rot section). The e2e suite
already captures it; just hasn't been actioned. Per Phase 2 spec, not
investigating / not fixing.

### Cancellation

The whole e2e suite was reported cancelled with `'Promise resolution
is still pending but the event loop has already resolved'` after
~15 minutes of wall time. The test process was hung after the UI
Automation suite finished — possibly waiting on a panel-dependent
timeout — and the kill was administered to unblock Phase 2. Not
investigated. Worth a Phase 3 look at test-suite robustness if test
runs become a recurring activity.

### Test-coverage gap discovered alongside

Phase 2 found that the drawing tools `draw_list`, `draw_get_properties`,
`draw_remove_one`, and `draw_clear` hard-fail in production with
`getChartApi is not defined`. The e2e suite reports all four as
**passing**. This means the unit tests are injecting `getChartApi` via
the `_deps` mechanism — exercising the dependency-injection path but
not the production bare-identifier path. The test setup masks the bug.
Phase 3 should add either an integration test that doesn't pass `_deps`
or a unit test specifically targeting the production code path.

## Persistent side effects from validation

Phase 2 Pine Script validation saved a script to Dylan's TradingView cloud
account. There is no MCP `pine_delete` tool — cleanup must be done
manually via the TradingView UI.

| Side effect | Created by | Cleanup required |
|---|---|---|
| Pine script `PHASE2_TEST_DO_NOT_USE` (id `USER;7be49b8e40a346f6a055969545f355ad`, v1.0) | Task 5 `pine_save` | Delete manually in TradingView (Pine Editor → Open → Right-click → Delete), after Phase 2 wraps |

Pattern note: any future validation that exercises `pine_save` should
prefix script names with a clear sentinel (`PHASE_N_TEST_DO_NOT_USE`) and
get appended to this list, so cleanup is never lost. Until a
`pine_delete` MCP tool exists, this is the only way to avoid drift in
the user's cloud script list.

## Transient (not a tool fault) — noting for completeness

- `layout_list` failed once with a Claude-side classifier error
  ("claude-opus-4-7[1m] is temporarily unavailable…"). Immediate retry
  succeeded with normal output. The MCP tool itself is fine; flagged
  only so it's clear this wasn't a TradingView/CDP issue.
