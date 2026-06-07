/**
 * Core indicator settings logic.
 */
import { evaluate, safeString, chartApiExpr } from '../connection.js';

/**
 * If pane_index is provided, look up the study only in that pane. Otherwise
 * search all panes (so an entity_id from chart_get_state without a pane hint
 * still resolves regardless of which pane is currently active).
 */
function studyLookupExpr(entity_id, pane_index) {
  const id = safeString(entity_id);
  if (pane_index === undefined || pane_index === null) {
    return `(function(){
      var n = window.TradingViewApi.chartsCount();
      for (var i = 0; i < n; i++) {
        try {
          var s = window.TradingViewApi.chart(i).getStudyById(${id});
          if (s) return { study: s, pane_index: i };
        } catch(e) {}
      }
      return null;
    })()`;
  }
  return `(function(){
    var s = null;
    try { s = ${chartApiExpr(pane_index)}.getStudyById(${id}); } catch(e) {}
    return s ? { study: s, pane_index: ${Number(pane_index)} } : null;
  })()`;
}

export async function setInputs({ entity_id, inputs: inputsRaw, pane_index }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);
  const lookup = studyLookupExpr(entity_id, pane_index);

  const result = await evaluate(`
    (function() {
      var found = ${lookup};
      if (!found) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var study = found.study;
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys, pane_index: found.pane_index };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, pane_index: result.pane_index, updated_inputs: result.updated_inputs };
}

export async function toggleVisibility({ entity_id, visible, pane_index }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const lookup = studyLookupExpr(entity_id, pane_index);

  const result = await evaluate(`
    (function() {
      var found = ${lookup};
      if (!found) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var study = found.study;
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible, pane_index: found.pane_index };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, pane_index: result.pane_index, visible: result.visible };
}
