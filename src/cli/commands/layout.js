import { register } from '../router.js';
import * as layoutCore from '../../core/layout.js';

register('layout', {
  description: 'Layout tools (list, switch, save-as, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List saved chart layouts (always fresh)',
      handler: () => layoutCore.list(),
    }],
    ['switch', {
      description: 'Switch to a saved layout by name or ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Layout name required. Usage: tv layout switch "My Layout"');
        return layoutCore.load({ name_or_id: positionals.join(' ') });
      },
    }],
    ['save-as', {
      description: 'Save the current chart as a new saved layout (silent — no dialog)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name required. Usage: tv layout save-as "My New Layout"');
        return layoutCore.saveAs({ name: positionals.join(' ') });
      },
    }],
    ['delete', {
      description: 'Delete a saved layout by name or ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Name or ID required. Usage: tv layout delete "My Layout"');
        return layoutCore.remove({ name_or_id: positionals.join(' ') });
      },
    }],
    ['current', {
      description: 'Show the currently-loaded layout',
      handler: () => layoutCore.current(),
    }],
  ]),
});
