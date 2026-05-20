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

## `watchlist_add` — fails when the watchlist panel is closed

- Input: `{ "symbol": "NASDAQ:NVDA" }`
- Response (verbatim):

  ```json
  {
    "success": false,
    "error": "Add symbol button not found in watchlist panel"
  }
  ```

- Consistent with `watchlist_get` having returned
  `source: "panel_closed"` earlier in the same session.
- Hypothesis: the implementation relies on clicking a DOM-rendered
  "Add" button inside the watchlist sidebar, so it requires the panel
  to be open. No automatic open-then-add fallback. Workaround for now:
  manually open the watchlist panel in TradingView, then retry.

## Transient (not a tool fault) — noting for completeness

- `layout_list` failed once with a Claude-side classifier error
  ("claude-opus-4-7[1m] is temporarily unavailable…"). Immediate retry
  succeeded with normal output. The MCP tool itself is fine; flagged
  only so it's clear this wasn't a TradingView/CDP issue.
