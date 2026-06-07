import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';

export function registerIndicatorTools(server) {
  const paneIndexSchema = z.coerce.number().int().nonnegative().optional()
    .describe('Pane index (0-based). Omit to search every pane for the entity_id.');

  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
    pane_index: paneIndexSchema,
  }, async ({ entity_id, inputs, pane_index }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs, pane_index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
    pane_index: paneIndexSchema,
  }, async ({ entity_id, visible, pane_index }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible, pane_index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
