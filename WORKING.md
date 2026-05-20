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
