# TradingView MCP — Phase 2 Validation Priorities

Tools below were out of scope for Phase 1 but are the next logical
batch to exercise. One-line purpose each.

- `data_get_study_values` — Read current numeric values from visible
  indicators (RSI, MACD, EMA, etc.); core dependency for any
  signal/analysis loop.
- `capture_screenshot` — Capture chart / strategy-tester regions;
  needed for visual verification, doc artifacts, and any human-in-loop
  review flow.
- `pine_set_source` — Inject Pine Script into the editor; foundation
  for any programmatic indicator/strategy authoring.
- `pine_smart_compile` — Compile + error-check Pine source.
  **Note:** documented to make Node-side calls to TradingView servers;
  validate network behavior in a sandbox before relying on it.
- `alert_create` — Create chart alerts programmatically; required for
  any monitoring / notification workflow.
- `alert_list` — Enumerate existing alerts to avoid duplicates and to
  support reconciliation.
- `alert_delete` — Clean up alerts; pairs with `alert_create` for
  full lifecycle coverage.

## Also worth retrying in Phase 2

- `tab_new` / `tab_switch` / `tab_close` — Phase 1 found `tab_new`
  silently fails on TVDesktop 3.1.0; revisit if the upstream repo
  ships a fix or after testing alternate triggers.
- `watchlist_add` — Phase 1 found it requires the watchlist panel to
  be open; revisit with the panel pre-opened, or look for a tool that
  opens the panel first.
