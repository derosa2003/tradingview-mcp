/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const before = await list();
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  const after = await list();
  if (after.tab_count <= before.tab_count) {
    return {
      success: false,
      action: 'new_tab_opened',
      error: `New tab did not appear (tabs_before=${before.tab_count}, tabs_after=${after.tab_count}). CDP keyboard event may not be reaching the tab strip on this TradingView version.`,
      tabs_before: before.tab_count,
      tabs_after: after.tab_count,
      tab_count: after.tab_count,
      tabs: after.tabs,
    };
  }
  return { success: true, action: 'new_tab_opened', tabs_before: before.tab_count, ...after };
}

/**
 * Close a specific tab by index (from tab_list), targeting its CDP page target
 * directly. The old implementation fired Cmd/Ctrl+W, which closes whatever tab
 * is *frontmost* — it could close the user's real chart. An explicit index is
 * now required so the close is deterministic.
 */
export async function closeTab({ index } = {}) {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }
  if (index === undefined || index === null) {
    return {
      success: false,
      error: 'tab_close requires an explicit index (from tab_list) so it never closes the wrong chart. Pass { index } for the tab you want to close.',
      tabs: before.tabs,
    };
  }
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= before.tab_count) {
    throw new Error(`Tab index ${index} out of range (have ${before.tab_count} tabs).`);
  }
  const target = before.tabs[idx];

  // Close the specific CDP page target by id — deterministic, not frontmost.
  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${target.id}`);
  } catch (e) {
    throw new Error(`Failed to close tab ${idx} (${target.id}): ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 800));

  const after = await list();
  const closed = after.tab_count < before.tab_count;
  return {
    success: closed,
    action: 'tab_closed',
    closed_index: idx,
    closed_chart_id: target.chart_id,
    tabs_before: before.tab_count,
    tabs_after: after.tab_count,
    ...(closed ? {} : { error: 'Tab count did not decrease; the close request may not have landed.' }),
  };
}

/**
 * Bring a tab to the front by index (CDP activate). NOTE: this only changes
 * which tab is visually frontmost — it does NOT repoint the MCP's CDP client at
 * the new tab's target, so subsequent chart/data tools still operate on the
 * originally-connected chart. Driving a different chart should be done with
 * pane_index / layout tools, not by switching tabs.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    return {
      success: true,
      action: 'switched',
      index: idx,
      tab_id: target.id,
      chart_id: target.chart_id,
      note: 'Tab brought to front visually. The MCP connection still targets the original tab — chart/data tools will not operate on this tab until the server reconnects.',
    };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
