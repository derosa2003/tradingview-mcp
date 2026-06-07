# TradingView MCP — Phase 1: Working Tools

Validated 2026-05-20 against a live TradingView Desktop 3.1.0 session
(Chrome/140 via CDP on :9222). Pinned commit:
4795784a19dd64ff4e2649d2499a536b01bd2d68.

All tools below returned `success: true` and produced the expected
side-effect or payload. Inputs are shown exactly as sent (schema field
names, which differ from the prompt's shorthand in a few places — noted
inline).

## Read-only / inspection

### `tv_health_check`
- Input: `{}`
- Returns `cdp_connected`, `target_id`, `target_url`, `chart_symbol`,
  `chart_resolution`, `chart_type`, `api_available`. Confirmed
  `cdp_connected: true`.

### `chart_get_state`
- Input: `{}`
- Returns `symbol`, `resolution`, `chartType`, and `studies[]` with
  `id` + `name` for each. Entity ids returned here are the ones you
  pass to `chart_manage_indicator` for removal.

### `quote_get`
- Input: `{}` (blank symbol = current chart)
- Returns OHLCV, last, time, description, exchange, type.

### `tab_list`
- Input: `{}`
- Returns `tab_count` and `tabs[]` with `index`, `id`, `title`, `url`,
  `chart_id`.

### `pane_list`
- Input: `{}`
- Returns `layout` (code), `layout_name`, `chart_count`,
  `active_index`, and `panes[]` with `index`, `symbol`, `resolution`.

### `layout_list`
- Input: `{}`
- Returns `layouts[]` with `id`, `name`, `symbol`, `resolution`,
  `modified`, and `source: "internal_api"`.

### `watchlist_get`
- Input: `{}`
- Returned `count: 0`, `source: "panel_closed"`, `symbols: []`. The
  `source` field distinguishes empty-watchlist from panel-not-open;
  treat `panel_closed` as "no data available," not a real failure.

## State-mutating chart controls

### `chart_set_symbol`
- Input: `{ "symbol": "NASDAQ:AAPL" }`
- Symbol changed on the active pane. Response includes `chart_ready`
  (was `false` immediately after call — chart loads asynchronously).

### `chart_set_timeframe`
- Input: `{ "timeframe": "D" }`
- Use TradingView timeframe codes: `1, 5, 15, 60, 120, D, W, M`.

### `chart_set_type`
- Input: `{ "chart_type": "Candles" }`
- **Schema field is `chart_type`, not `type`.** Accepts name or number
  (e.g., `"Candles"` or `1`).

### `pane_set_layout`
- Input: `{ "layout": "2x2" }` (first attempt, accepted)
- The alias `"2x2"` is normalized to layout code `"4"` in the
  response (`layout_name: "2x2 grid"`). Canonical codes per server
  description: `s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8`. Aliases also
  accepted: `single, 2x1, 1x2, 2x2, quad`.

### `pane_set_symbol`
- Input: `{ "index": 1, "symbol": "NASDAQ:MSFT" }`
- **Schema field is `index`, not `pane`.** 0-based.

### `pane_focus`
- Input: `{ "index": 0 }`
- Response confirms `focused_index` and `total_panes`.

### `layout_switch`
- Input: `{ "name": "93858081" }` (id from `layout_list`)
- Switches saved layouts. **Important side-effect:** response field
  `unsaved_dialog_dismissed: true` indicates the server auto-dismissed
  TradingView's "unsaved changes" dialog. Any in-flight modifications
  to the source layout that weren't saved are discarded silently.

### `chart_manage_indicator` (add)
- Input: `{ "action": "add", "indicator": "Relative Strength Index" }`
- **Schema field is `indicator`, not `name`.** Returns the new
  `entity_id` (needed for removal).

### `chart_manage_indicator` (remove)
- Input: `{ "action": "remove", "indicator": "Relative Strength Index",
  "entity_id": "EGZWWH" }`
- Both `indicator` and `entity_id` were supplied; entity_id is the
  reliable selector (get it from `chart_get_state.studies[].id` or
  the add-call response).

## Field-name reference (schema vs prompt shorthand)

| Tool | Prompt said | Actual schema field |
| --- | --- | --- |
| `chart_set_type` | `type` | `chart_type` |
| `pane_set_symbol` | `pane` | `index` |
| `chart_manage_indicator` | `name` | `indicator` |

---

# Phase 2 — Validation (2026-05-20)

Validated against the same TradingView Desktop 3.1.0 session, on pinned
commit `b2e07fa` (Scope B hardening). New tool tiers exercised; Scope B
patches re-validated; Phase 1 passers smoke-tested to detect regression.
Findings live in `KNOWN_ISSUES.md`; this section captures what works.

## Scope B patch re-validation

| Tool | Pre-state | Patch behavior | End-state | Verdict |
| --- | --- | --- | --- | --- |
| `tab_new` | `tab_count: 1` | Returned `success: false` with honest diagnostic (`tabs_before=1, tabs_after=1`) | unchanged | ✅ patch correct; tool still cannot open a tab on TVDesktop 3.1.0, but failure is no longer silent |
| `tab_close` | only 1 tab | n/a (would destroy chart session) | n/a | ⏸ untested in Phase 2 — protective skip |
| `watchlist_add` | panel closed | Routes through canonical `openPanel({panel:'watchlist',action:'open'})`; propagates `openPanel`'s failure honestly via `throw` | unchanged | ✅ routing patch correct; **end-to-end blocked on `openPanel` selector regression** (see `KNOWN_ISSUES.md`) |

## Phase 1 smoke (regression check)

13 of the 14 Phase 1 passing tools re-invoked once each (skipping
`layout_switch` for silent-data-loss risk, plus `tab_new`/`watchlist_add`
which Task 2 covered). All 13 returned the same shape and structure as
Phase 1. **No regressions detected from `b2e07fa`.**

## Chart reading tier

| Tool | Verdict | Notes |
| --- | --- | --- |
| `chart_get_state` | ✅ | XLE / 1D / type 1 / Volume study — consistent across calls |
| `data_get_study_values` | ✅ | Returns study name + current `values` map |
| `data_get_ohlcv` (summary) | ✅ | Compact stats: 100-bar window OHLC, range, change %, avg_volume, last_5_bars |
| `data_get_ohlcv` (count) | ✅ | Returns `bars[]`, includes `total_available` (1318 daily bars on XLE) |
| `capture_screenshot` | ✅ | Writes PNG to `screenshots/` (covered by `.gitignore`). Verified file exists, byte-count matches `size_bytes`, valid PNG header (2008x747) |

## Pine Script tier

Required a workaround to even open the editor: `ui_open_panel(pine-editor)`
is a handler-not-wired no-op on TVDesktop 3.1.0 (see `KNOWN_ISSUES.md`).
Manual `bwb.open() + bwb.show('pine-editor')` via `ui_evaluate` made
Monaco reachable; from there the actual Pine tools work.

| Tool | Verdict | Notes |
| --- | --- | --- |
| `pine_new` | ✅ (after workaround) | Injects template into Monaco |
| `pine_set_source` | ✅ | Lines reported match input |
| `pine_get_source` | ✅ | **Round-trip exact match** — set source and read back, 60 chars verbatim |
| `pine_smart_compile` (happy) | ⚠️ partial | Returns. Wall-clock ~3.9s (incl. 2.5s internal sleep → ~1.4s actual). `study_added: false` because the "Add to chart" button DOM selector is stale — falls through to "Pine Save" |
| `pine_smart_compile` (broken script) | ✅ | Surfaces a real Monaco severity-8 error: `Mismatched input 'end of line without line continuation' expecting ')'` at line 2 col 19 |
| `pine_get_errors` | ✅ | Same markers as `smart_compile`. Note: lumps Monaco severity 4 (warning) and 8 (error) into the same `errors` field — see `KNOWN_ISSUES.md` |
| `pine_get_console` | ⚠️ noisy | Returns entries but they're DOM-scraped text concatenations, not structured log lines |
| `pine_save` | ✅ | `action: "saved_with_dialog"` — handled the auto-opened name dialog. TradingView pre-fills the name input from the `indicator("...")` title |
| `pine_list_scripts` | ✅ | **Fire-and-trust verified** — `PHASE2_TEST_DO_NOT_USE` confirmed present with id `USER;7be49b8e40a346f6a055969545f355ad` |

### Network behavior of Pine tier

| Tool | Network category |
| --- | --- |
| `pine_smart_compile` | Renderer-side only (button clicks + Monaco marker reads). No Node-side fetch |
| `pine_list_scripts`, `pine_open` | Browser-context `fetch` to `pine-facade.tradingview.com` with `credentials: 'include'` — user's existing session |
| `pine_check` (not exercised this phase) | Node-side anonymous `fetch` to `pine-facade.tradingview.com/pine-facade/translate_light` with `Referer` only, no auth — the permitted relaxed-rule call |

## Alerts tier

| Tool | Verdict | Notes |
| --- | --- | --- |
| `alert_list` | ✅ | Browser-context fetch to `pricealerts.tradingview.com/list_alerts` (renderer-side, user session — not Node-side, doesn't trigger relaxed-rule concern). Returns count + alerts array |
| `alert_create` | ❌ honest failure | Selector rot on `[class*="alert"] input` — see `KNOWN_ISSUES.md` |
| `alert_delete` | ⏸ untested | Tool is delete-all-only (schema-level gap, not selector). Permission guardrail correctly refused `delete_all: true` |

## Drawing tools tier

| Tool | Verdict | Notes |
| --- | --- | --- |
| `draw_shape` | ✅ | Created horizontal_line; returned `entity_id`. Has good built-in fire-and-trust hygiene (before/after `getAllShapes()` ID diff) |
| `draw_list`, `draw_remove_one`, `draw_clear`, `draw_get_properties` | ❌ in-source bug | All fail with `getChartApi is not defined` — bare-identifier reference, see `KNOWN_ISSUES.md`. Trivially fixable. |

Side-effect verification on `draw_shape` done via direct chart-API call
since `draw_list` is broken. Pre-existing user shape (`FHHECU` trend_line)
preserved; Phase 2's horizontal_line cleaned up via `chart.removeEntity`.

## `npm test` one-off

66/68 pass, 1 deterministic fail, 1 cancellation. Single failure is
`ui_open_panel — open/close pine-editor` with
`TypeError: bwb.hideWidget is not a function` — matches the live finding
about `hideWidget` being missing on TVDesktop 3.1.0. Full breakdown in
`KNOWN_ISSUES.md`. Also: drawing tools all reported passing in the
suite, masking the production `getChartApi is not defined` bug — a
test-coverage gap also noted there.
