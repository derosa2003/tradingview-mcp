/**
 * Indicator Templates — wrap TradingView's internal study-templates drawer
 * service so a model can save / list / apply / delete templates without
 * navigating the UI manually.
 *
 * Apply is fully silent (the underlying applyTemplate call talks straight to
 * the chart model). Save and delete open small confirmation dialogs in TV's
 * native UI; we drive them programmatically by polling for the dialog element
 * and clicking through. List uses the cached service plus an explicit refresh.
 *
 * APIs reached:
 *   const drawer = await window.TradingViewApi.studyTemplatesDrawerApi();
 *   const svc = drawer._model._studyTemplates;
 *   svc.list() / svc.refreshStudyTemplateList() / svc.applyTemplate(name) /
 *     svc.deleteStudyTemplate(name) / svc.showSaveAsDialog(content)
 */
import { evaluate, evaluateAsync, safeString, chartApiExpr } from '../connection.js';

const DRAWER = 'await window.TradingViewApi.studyTemplatesDrawerApi()';
const SVC = '(await window.TradingViewApi.studyTemplatesDrawerApi())._model._studyTemplates';

/**
 * List all saved indicator templates, refreshing from the server first.
 */
export async function list() {
  const data = await evaluateAsync(`
    (async function(){
      var d = ${DRAWER};
      var s = d._model._studyTemplates;
      try { s.refreshStudyTemplateList(); } catch(e) {}
      await new Promise(function(r){ setTimeout(r, 400); });
      var arr = s.list() || [];
      return arr.map(function(t){
        var studyCount = 0;
        try {
          // meta_info has indicator names; not always parseable, but length is a useful hint
          if (t.meta_info && t.meta_info.indicators && Array.isArray(t.meta_info.indicators)) {
            studyCount = t.meta_info.indicators.length;
          }
        } catch(e) {}
        return { id: t.id, name: t.name, is_default: !!t.is_default, study_count: studyCount, favorite: !!t.favorite_date };
      });
    })()
  `);
  return { success: true, template_count: data.length, templates: data };
}

/**
 * Apply a saved template by name to a target pane. Silent — no dialog.
 * Note: applyStudyTemplate replaces all studies in the target pane (TV's
 * native behavior). Pass replace=false to layer instead — implemented by
 * snapshotting and re-adding studies after.
 */
export async function apply({ name, pane_index, replace = true }) {
  if (!name) throw new Error('name is required');
  const apiExpr = chartApiExpr(pane_index);

  if (!replace) {
    // Refuse BEFORE doing anything destructive. TradingView's applyStudyTemplate
    // always replaces every study in the target pane — there is no native layer
    // mode. The old code applied (destroying the pane's studies) and only then
    // reported they were gone. Fail loudly instead of destroy-and-report.
    throw new Error(
      'replace=false is not supported: TradingView\'s applyStudyTemplate ALWAYS replaces all studies in the target pane (no native layer mode). ' +
      'No studies were touched. To keep the current studies, save them as a template first, then apply with replace=true (the default).'
    );
  }

  await _doApply(name, pane_index);

  // Read back studies to confirm
  const after = await evaluate(`
    (function(){
      return ${apiExpr}.getAllStudies().map(function(s){ return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, name, pane_index: pane_index ?? null, studies: after };
}

async function _doApply(name, pane_index) {
  // applyTemplate uses activeChartWidget internally. Switch to the target pane first.
  if (pane_index !== undefined && pane_index !== null) {
    await evaluate(`window.TradingViewApi.setActiveChart(${Number(pane_index)})`);
    // wait for the active index to settle
    for (let i = 0; i < 20; i++) {
      const cur = await evaluate('window.TradingViewApi.activeChartIndex()');
      if (cur === Number(pane_index)) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }
  const result = await evaluateAsync(`
    (async function(){
      var s = ${SVC};
      var rec = s.findRecordByName(${safeString(name)});
      if (!rec) {
        // try refresh + retry once
        s.refreshStudyTemplateList();
        await new Promise(function(r){ setTimeout(r, 400); });
        rec = s.findRecordByName(${safeString(name)});
      }
      if (!rec) throw new Error('Template "' + ${safeString(name)} + '" not found');
      s.applyTemplate(${safeString(name)});
      // applyTemplate is fire-and-forget; wait a bit for studies to load
      await new Promise(function(r){ setTimeout(r, 1800); });
      return { id: rec.id, name: rec.name };
    })()
  `);
  return result;
}

/**
 * Save the current pane's studies as a new template. Drives TV's save-as
 * dialog programmatically: triggers it, waits for the input to appear, fills
 * the name using React's native input setter (so React sees the change), then
 * clicks the primary action.
 */
export async function save({ name, pane_index, on_conflict = 'error' }) {
  if (!name || typeof name !== 'string') throw new Error('name is required (string)');
  if (!['error', 'overwrite'].includes(on_conflict)) {
    throw new Error('on_conflict must be "error" or "overwrite"');
  }

  // Refresh + check for conflict
  const existing = await list();
  const conflict = existing.templates.find(t => t.name === name);
  let deletedExisting = false;
  if (conflict) {
    if (on_conflict === 'error') {
      throw new Error(`A template named "${name}" already exists. Pass on_conflict:"overwrite" to replace.`);
    }
    // NOTE: TradingView has no atomic template-replace; overwrite = delete then
    // re-save. If the re-save fails below, the original is gone — we surface
    // that explicitly in the failure path rather than failing silently.
    await remove({ name });
    deletedExisting = true;
  }

  // Switch to the target pane (template captures from active chart)
  if (pane_index !== undefined && pane_index !== null) {
    await evaluate(`window.TradingViewApi.setActiveChart(${Number(pane_index)})`);
    for (let i = 0; i < 20; i++) {
      const cur = await evaluate('window.TradingViewApi.activeChartIndex()');
      if (cur === Number(pane_index)) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  const result = await evaluateAsync(`
    (async function(){
      var d = ${DRAWER};
      var s = d._model._studyTemplates;
      var apiExpr = ${chartApiExpr(pane_index)};
      var content = apiExpr.createStudyTemplate({ saveSymbol: false, saveInterval: false });
      s.showSaveAsDialog(content);

      // Poll for the dialog and its name input
      var deadline = Date.now() + 8000;
      var input = null;
      var dialog = null;
      while (Date.now() < deadline) {
        var dialogs = document.querySelectorAll('[role="dialog"], [data-name="popup-dialog"], [data-dialog-name]');
        for (var i = 0; i < dialogs.length; i++) {
          var dd = dialogs[i];
          var txt = (dd.textContent || '').toLowerCase();
          if (txt.indexOf('template') !== -1 || txt.indexOf('save') !== -1) {
            var ii = dd.querySelector('input[type="text"]') || dd.querySelector('input:not([type]):not([disabled])');
            if (ii) { input = ii; dialog = dd; break; }
          }
        }
        if (input) break;
        await new Promise(function(r){ setTimeout(r, 200); });
      }
      if (!input) throw new Error('Template save dialog never appeared');

      // Fill name via React-aware setter
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, ${safeString(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(function(r){ setTimeout(r, 250); });

      // Click the primary action button — WHITELIST ONLY. Never fall back to
      // "the last button on the page/dialog": that is exactly how a stale
      // selector turns a save into a destructive misclick (cf. the pine
      // smart_compile saveButton fall-through). If nothing matches, throw.
      var btns = dialog.querySelectorAll('button');
      var btn = null;
      for (var j = 0; j < btns.length; j++) {
        var t = (btns[j].textContent || '').trim().toLowerCase();
        if (t === 'save' || t === 'create' || t === 'ok' || t === 'submit' ||
            t === 'overwrite' || t === 'replace' || /^save\b/.test(t) || /^create\b/.test(t)) { btn = btns[j]; break; }
      }
      if (!btn) {
        var labels = Array.prototype.map.call(btns, function(b){ return (b.textContent||'').trim(); }).filter(Boolean).join(' | ');
        throw new Error('No whitelisted save/create button in template dialog — refusing to click an arbitrary button. Buttons seen: [' + labels + ']');
      }
      btn.click();

      // Wait for save then refresh
      await new Promise(function(r){ setTimeout(r, 1500); });
      s.refreshStudyTemplateList();
      await new Promise(function(r){ setTimeout(r, 600); });
      var newList = s.list();
      var rec = newList.find(function(t){ return t.name === ${safeString(name)}; });
      return rec ? { id: rec.id, name: rec.name } : null;
    })()
  `);

  if (!result) {
    const lost = deletedExisting
      ? ' WARNING: the existing template was already deleted as part of the overwrite and has been LOST — re-save it from the pane.'
      : '';
    throw new Error(`Template "${name}" did not appear in the list after save. The dialog interaction may have failed.${lost}`);
  }
  return { success: true, id: result.id, name: result.name, pane_index: pane_index ?? null };
}

/**
 * Delete a template by name. Drives TV's "are you sure?" confirm dialog
 * programmatically — clicks the danger button.
 */
export async function remove({ name }) {
  if (!name) throw new Error('name is required');

  const result = await evaluateAsync(`
    (async function(){
      var d = ${DRAWER};
      var s = d._model._studyTemplates;
      s.refreshStudyTemplateList();
      await new Promise(function(r){ setTimeout(r, 300); });
      var rec = s.findRecordByName(${safeString(name)});
      if (!rec) return { not_found: true };

      s.deleteStudyTemplate(${safeString(name)});

      // Poll for confirm dialog and click danger button
      var deadline = Date.now() + 6000;
      var btn = null;
      while (Date.now() < deadline) {
        var btns = document.querySelectorAll('[role="dialog"] button, [data-name*="confirm"] button');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var t = (b.textContent || '').trim().toLowerCase();
          var c = b.className || '';
          if ((t === 'delete' || t === 'remove' || t === 'yes' || t === 'ok') &&
              (/danger|primary|red/i.test(c) || /danger|primary/i.test(b.getAttribute('data-name') || ''))) {
            btn = b; break;
          }
        }
        // fallback: any button literally labeled "Delete"
        if (!btn) {
          var allBtns = document.querySelectorAll('[role="dialog"] button');
          for (var j = 0; j < allBtns.length; j++) {
            var bt = (allBtns[j].textContent || '').trim().toLowerCase();
            if (bt === 'delete' || bt === 'remove') { btn = allBtns[j]; break; }
          }
        }
        if (btn) break;
        await new Promise(function(r){ setTimeout(r, 200); });
      }
      if (!btn) throw new Error('Template delete confirm dialog never appeared');
      btn.click();
      await new Promise(function(r){ setTimeout(r, 1200); });
      s.refreshStudyTemplateList();
      await new Promise(function(r){ setTimeout(r, 500); });
      var stillThere = !!s.findRecordByName(${safeString(name)});
      return { deleted: !stillThere, id: rec.id };
    })()
  `);

  if (result.not_found) return { success: true, deleted: false, note: 'Template not found (already deleted or never existed)' };
  if (!result.deleted) throw new Error(`Template "${name}" still present after delete attempt`);
  return { success: true, deleted: true, id: result.id, name };
}
