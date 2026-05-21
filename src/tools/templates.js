import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/templates.js';

export function registerTemplateTools(server) {
  const paneIndexSchema = z.coerce.number().int().nonnegative().optional()
    .describe('Pane index (0-based). Omit for the currently active pane.');

  server.tool('indicator_template_list', 'List saved indicator templates (per-user, persisted server-side). Refreshes the cache before reading.', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_template_apply', 'Apply a saved indicator template to a pane by name. Silent — no dialog. Note: applyStudyTemplate replaces all studies in the target pane (TradingView native behavior).', {
    name: z.string().describe('Template name (exact match)'),
    pane_index: paneIndexSchema,
    replace: z.coerce.boolean().optional().describe('Default true. Pass false to acknowledge the layer-mode limitation (TV always replaces).'),
  }, async ({ name, pane_index, replace }) => {
    try { return jsonResult(await core.apply({ name, pane_index, replace })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_template_save', 'Save the indicators on the target pane as a new template. Briefly opens TradingView\'s save-as dialog and drives it programmatically — may be brittle in unusual UI states.', {
    name: z.string().describe('Name for the new template'),
    pane_index: paneIndexSchema,
    on_conflict: z.enum(['error', 'overwrite']).optional().describe('"error" (default) → fail if a template with the same name exists. "overwrite" → delete the existing first.'),
  }, async ({ name, pane_index, on_conflict }) => {
    try { return jsonResult(await core.save({ name, pane_index, on_conflict })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_template_delete', 'Delete a template by name. Drives TV\'s confirm dialog programmatically. Idempotent — returns success even if the template is already gone.', {
    name: z.string().describe('Template name to delete'),
  }, async ({ name }) => {
    try { return jsonResult(await core.remove({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
