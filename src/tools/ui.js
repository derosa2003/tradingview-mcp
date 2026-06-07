import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/ui.js';
import * as layoutCore from '../core/layout.js';

export function registerUiTools(server) {
  server.tool('ui_click', 'Click a UI element by aria-label, data-name, text content, or class substring', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match against the chosen selector strategy'),
  }, async ({ by, value }) => {
    try { return jsonResult(await core.click({ by, value })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_open_panel', 'Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)', {
    panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).describe('Panel name'),
    action: z.enum(['open', 'close', 'toggle']).describe('Action to perform'),
  }, async ({ panel, action }) => {
    try { return jsonResult(await core.openPanel({ panel, action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_fullscreen', 'Toggle TradingView fullscreen mode', {}, async () => {
    try { return jsonResult(await core.fullscreen()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_list', 'List saved chart layouts (always reads fresh from TradingView — no MCP-side cache)', {
    refresh: z.coerce.boolean().optional().describe('Force a backend refresh before reading (default true). Pass false to read the in-memory state for a faster but possibly stale read.'),
  }, async ({ refresh } = {}) => {
    try { return jsonResult(await layoutCore.list({ refresh: refresh !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_switch', 'Switch to a saved chart layout by name or ID', {
    name: z.string().describe('Name or ID of the layout to switch to'),
  }, async ({ name }) => {
    try { return jsonResult(await layoutCore.load({ name_or_id: name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_current', 'Get the currently-loaded layout (id, name, uid)', {}, async () => {
    try { return jsonResult(await layoutCore.current()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_save_as', 'Save the current chart as a NEW saved layout via saveChartSilently — no "Make a copy" dialog. Returns the new layout id. By default the local chart stays on the original layout so subsequent saves go to the original, not the new copy.', {
    name: z.string().describe('Name for the new layout'),
    on_conflict: z.enum(['error', 'overwrite']).optional().describe('"error" (default) → fail if a layout with the same name already exists. "overwrite" → delete the existing same-named layout first.'),
    stay_on_original: z.coerce.boolean().optional().describe('Default true. After save, restore the local chart back to the original layout. Pass false to switch to the new clone (matches TradingView\'s native Save As behavior).'),
  }, async ({ name, on_conflict, stay_on_original }) => {
    try { return jsonResult(await layoutCore.saveAs({ name, on_conflict, stay_on_original: stay_on_original !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_delete', 'Delete a saved layout by name or id. If the deleted layout was the currently-active one, TradingView clears the chart metaInfo (you may want to load_chart after).', {
    name_or_id: z.string().describe('Name (case-insensitive) or numeric id of the layout to delete'),
  }, async ({ name_or_id }) => {
    try { return jsonResult(await layoutCore.remove({ name_or_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_keyboard', 'Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)', {
    key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "a", "ArrowUp")'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys to hold (e.g., ["ctrl", "shift"])'),
  }, async ({ key, modifiers }) => {
    try { return jsonResult(await core.keyboard({ key, modifiers })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_type_text', 'Type text into the currently focused input/textarea element', {
    text: z.string().describe('Text to type into the focused element'),
  }, async ({ text }) => {
    try { return jsonResult(await core.typeText({ text })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_hover', 'Hover over a UI element by aria-label, data-name, or text content', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match'),
  }, async ({ by, value }) => {
    try { return jsonResult(await core.hover({ by, value })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_scroll', 'Scroll the chart or page up/down/left/right', {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.coerce.number().optional().describe('Scroll amount in pixels (default 300)'),
  }, async ({ direction, amount }) => {
    try { return jsonResult(await core.scroll({ direction, amount })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_mouse_click', 'Click at specific x,y coordinates on the TradingView window', {
    x: z.coerce.number().describe('X coordinate (pixels from left)'),
    y: z.coerce.number().describe('Y coordinate (pixels from top)'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
    double_click: z.coerce.boolean().optional().describe('Double click (default false)'),
  }, async ({ x, y, button, double_click }) => {
    try { return jsonResult(await core.mouseClick({ x, y, button, double_click })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_find_element', 'Find UI elements by text, aria-label, or CSS selector and return their positions', {
    query: z.string().describe('Text content, aria-label value, or CSS selector to search for'),
    strategy: z.enum(['text', 'aria-label', 'css']).optional().describe('Search strategy (default: text)'),
  }, async ({ query, strategy }) => {
    try { return jsonResult(await core.findElement({ query, strategy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_evaluate', 'Execute JavaScript code in the TradingView page context for advanced automation', {
    expression: z.string().describe('JavaScript expression to evaluate in the page context. Wrap in IIFE for complex logic.'),
  }, async ({ expression }) => {
    try { return jsonResult(await core.uiEvaluate({ expression })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
