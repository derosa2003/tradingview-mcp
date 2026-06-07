/**
 * Saved chart layout management (cloud-side).
 *
 * Layout list / load / save-as / delete operations go through the internal
 * `_loadChartService` and `_saveChartService` APIs so they don't depend on
 * any dialogs or UI panels and never read from a stale cache.
 *
 * Save-as recipe (mirrors TV's own _doCloneCurrentLayout):
 *   1. Snapshot current id / uid / name
 *   2. Clear id + uid + set new name on cwc.metaInfo
 *   3. Call _saveChartService.saveChartSilently(success, error, { autoSave: false })
 *      → server creates a NEW layout with the new name (because id was null)
 *   4. After save, restore id/uid/name on the local chart so the user stays on
 *      the original layout (the new copy lives only on the server).
 *
 * Restoring local metaInfo is critical: without it, the user's next save would
 * silently overwrite the new clone instead of their original layout.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';

const LCS = 'window.TradingViewApi._loadChartService';
const SCS = 'window.TradingViewApi._saveChartService';
const CWC_META = 'window.TradingViewApi._chartWidgetCollection.metaInfo';

/**
 * Read the chart list directly from the load service state, force-refreshing
 * first so the result reflects any server-side mutations (including those made
 * by other clients / windows).
 */
export async function list({ refresh = true } = {}) {
  const data = await evaluateAsync(`
    (async function(){
      ${refresh ? `await ${LCS}.refreshChartList();` : ''}
      var v = ${LCS}._state.value();
      var list = (v && v.chartList) || [];
      return list.map(function(c){
        return {
          id: c.id, url: c.url, name: c.name, symbol: c.symbol,
          interval: c.interval, modified: c.modified, favorite: !!c.favorite,
        };
      });
    })()
  `);
  return { success: true, layout_count: data.length, layouts: data };
}

/**
 * Get the currently-loaded layout's metadata.
 */
export async function current() {
  const meta = await evaluate(`
    (function(){
      var m = ${CWC_META};
      var id = (m && m.id && typeof m.id.value === 'function') ? m.id.value() : null;
      var name = (m && m.name && typeof m.name.value === 'function') ? m.name.value() : null;
      var uid = (m && m.uid && typeof m.uid.value === 'function') ? m.uid.value() : null;
      return { id: id, name: name, uid: uid };
    })()
  `);
  return { success: true, ...meta };
}

/**
 * Switch to a saved layout by name (case-insensitive) or numeric id.
 * Returns once the underlying load promise resolves.
 */
export async function load({ name_or_id }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  const target = String(name_or_id);
  const isId = /^\d+$/.test(target);
  const layouts = (await list()).layouts;
  let match;
  if (isId) {
    match = layouts.find(l => String(l.id) === target);
    if (!match) throw new Error(`No layout with id ${target}`);
  } else {
    const lower = target.toLowerCase();
    match = layouts.find(l => (l.name || '').toLowerCase() === lower)
        || layouts.find(l => (l.name || '').toLowerCase().includes(lower));
    if (!match) throw new Error(`No layout matching "${target}"`);
  }
  // loadChartFromServer navigates the chart, which destroys the JS execution
  // context mid-call — so awaiting its promise throws "Promise was collected".
  // Fire it and tolerate that specific navigation error, then verify by polling.
  try {
    await evaluateAsync(`window.TradingViewApi.loadChartFromServer(${match.id})`);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/Promise was collected|context was destroyed|target navigated|Cannot find context|detached/i.test(msg)) throw e;
  }

  // Dismiss "unsaved changes" confirmation if present (best-effort).
  await new Promise(r => setTimeout(r, 600));
  try {
    await evaluate(`
      (function(){
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var text = (btns[i].textContent || '').trim();
          if (/open anyway|don't save|discard/i.test(text)) { btns[i].click(); return true; }
        }
        return false;
      })()
    `);
  } catch {}

  // Verify the switch landed by polling the currently-loaded layout id (the
  // context comes back a couple seconds after the navigation).
  let loaded = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const cur = await current();
      if (cur && String(cur.id) === String(match.id)) { loaded = true; break; }
    } catch { /* context mid-navigation — keep polling */ }
  }
  return {
    success: loaded,
    id: match.id,
    name: match.name,
    ...(loaded ? {} : { warning: 'Issued loadChartFromServer but could not confirm the layout loaded within timeout — verify with layout_current.' }),
  };
}

/**
 * Create a new saved layout from the current chart, without any dialogs.
 *
 * @param {string} name           Name for the new layout.
 * @param {string} on_conflict    'error' (default) → fail if a layout with the same
 *                                name already exists. 'overwrite' → delete the
 *                                existing same-named layout first.
 * @param {boolean} stay_on_original  Default true. After save, restore the
 *                                local chart back to the original layout's id
 *                                and name so the user keeps editing the
 *                                original. Pass false to switch to the new
 *                                clone (matching TV's "Save As" default).
 */
export async function saveAs({ name, on_conflict = 'error', stay_on_original = true }) {
  if (!name || typeof name !== 'string') throw new Error('name is required (string)');
  if (!['error', 'overwrite'].includes(on_conflict)) {
    throw new Error('on_conflict must be "error" or "overwrite"');
  }

  // Check for an existing layout with the same name.
  const layouts = (await list()).layouts;
  const conflict = layouts.find(l => (l.name || '') === name);
  if (conflict) {
    if (on_conflict === 'error') {
      throw new Error(`A layout named "${name}" already exists (id=${conflict.id}). Pass on_conflict:"overwrite" to replace it.`);
    }
    // Overwrite: delete the existing one first. _deleteChart only navigates if
    // we're deleting the *active* chart; we want to delete a different one,
    // so a refresh after is safe.
    await _deleteLayoutById(conflict.id, /* tolerateActive */ false);
  }

  const result = await evaluateAsync(`
    new Promise(function(resolve){
      try {
        var meta = ${CWC_META};
        var origId   = meta.id   && meta.id.value();
        var origName = meta.name && meta.name.value();
        var origUid  = meta.uid  && meta.uid.value();
        // Clear id/uid so saveChartSilently creates a new server-side layout.
        try { meta.uid.deleteValue(); } catch(e) {}
        meta.id.setValue(null);
        meta.name.setValue(${safeString(name)});

        ${SCS}.saveChartSilently(
          function(res){
            var newId  = meta.id   && meta.id.value();
            var newUid = meta.uid  && meta.uid.value();
            ${stay_on_original ? `
              // Restore local chart to the original layout so subsequent saves
              // go to origId, not the new clone.
              try { meta.id.setValue(origId); } catch(e) {}
              try { if (origUid) meta.uid.setValue(origUid); else meta.uid.deleteValue(); } catch(e) {}
              try { meta.name.setValue(origName); } catch(e) {}
            ` : `
              // Keep local state on the clone; the only fix-up needed is the
              // displayed name (saveChartSilently itself may have rewritten it).
              try { meta.name.setValue(${safeString(name)}); } catch(e) {}
            `}
            resolve({ ok: true, new_id: newId, new_uid: newUid, name: ${safeString(name)} });
          },
          function(err){
            // Best-effort revert so we don't leave the local chart in a half-cleared state.
            try { meta.id.setValue(origId); } catch(e) {}
            try { if (origUid) meta.uid.setValue(origUid); } catch(e) {}
            try { meta.name.setValue(origName); } catch(e) {}
            resolve({ ok: false, err: (err && err.message) ? err.message : String(err) });
          },
          { autoSave: false }
        );
        setTimeout(function(){ resolve({ ok: false, err: 'saveChartSilently timed out after 15s' }); }, 15000);
      } catch(e) { resolve({ ok: false, err: e.message }); }
    })
  `);

  if (!result.ok) throw new Error(result.err || 'Unknown save error');
  // refresh so the new id appears in subsequent list() calls
  await evaluateAsync(`${LCS}.refreshChartList()`);
  return { success: true, layout_id: result.new_id, name: result.name, stayed_on_original: stay_on_original };
}

/**
 * Delete a saved layout by name or id. If the chart is currently editing the
 * targeted layout, TradingView normally either navigates the tab or clears the
 * chart metaInfo; we tolerate that side effect and report it via `was_active`.
 */
export async function remove({ name_or_id }) {
  if (!name_or_id) throw new Error('name_or_id is required');
  const target = String(name_or_id);
  const isId = /^\d+$/.test(target);
  const layouts = (await list()).layouts;
  let match;
  if (isId) match = layouts.find(l => String(l.id) === target);
  else match = layouts.find(l => (l.name || '').toLowerCase() === target.toLowerCase());
  if (!match) throw new Error(`No layout matching "${target}"`);

  const was_active = await _deleteLayoutById(match.id, /* tolerateActive */ true);
  // refresh authoritative state
  try { await evaluateAsync(`${LCS}.refreshChartList()`); } catch {}
  return { success: true, deleted_id: match.id, name: match.name, was_active };
}

async function _deleteLayoutById(id, tolerateActive) {
  const result = await evaluateAsync(`
    new Promise(function(resolve){
      try {
        var lcs = ${LCS};
        var list = lcs._state.value().chartList || [];
        var entry = list.find(function(c){ return c.id === ${Number(id)}; });
        if (!entry) return resolve({ ok: false, err: 'not in chartList', was_active: false });
        var wasActive = false;
        try {
          var curId = ${CWC_META}.id && ${CWC_META}.id.value();
          wasActive = curId === entry.id;
        } catch(e) {}
        var p = entry.deleteAction();
        if (p && typeof p.then === 'function') {
          p.then(function(){ resolve({ ok: true, was_active: wasActive }); })
           .catch(function(e){ resolve({ ok: false, err: String(e), was_active: wasActive }); });
        } else {
          resolve({ ok: true, was_active: wasActive });
        }
        setTimeout(function(){ resolve({ ok: false, err: 'deleteAction timed out', was_active: wasActive }); }, 8000);
      } catch(e) { resolve({ ok: false, err: e.message, was_active: false }); }
    })
  `);
  if (!result.ok) throw new Error(result.err || 'delete failed');
  if (result.was_active && !tolerateActive) {
    throw new Error('Cannot delete the currently-active layout in this code path');
  }
  return !!result.was_active;
}
