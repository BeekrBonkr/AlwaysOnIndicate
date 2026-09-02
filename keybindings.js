// SPDX-License-Identifier: GPL-3.0-or-later
//
// The extension's own shortcuts. They are optional and default to unbound:
// GNOME already handles "toggle-above" and "toggle-on-all-workspaces" from
// org.gnome.desktop.wm.keybindings, and the preferences let you edit those
// directly. These add the combos GNOME does not have (pin both, unpin all,
// cycle pinned windows, open the menu, hide the indicators) and let you bind
// the basic toggles a second way.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const KEYBINDINGS = [
    ['kb-toggle-above', 'Toggle always on top', 'For the focused window'],
    ['kb-toggle-sticky', 'Toggle always on visible workspace', 'For the focused window'],
    ['kb-toggle-both', 'Pin / unpin', 'Sets both states, or clears both if either is set'],
    ['kb-unpin-all', 'Unpin all windows', 'Clears both states on every window'],
    ['kb-cycle-pinned', 'Cycle pinned windows', 'Activates the next pinned window'],
    ['kb-open-menu', 'Open the top bar menu', 'Requires the top bar indicator'],
    ['kb-toggle-indicators', 'Hide / show indicators', 'Temporarily hides all window outlines and badges'],
];

export class Keybindings {
    // handlers: {name → function}
    constructor(settings, handlers) {
        this._settings = settings;
        this._names = [];

        const modes = Shell.ActionMode.NORMAL |
            Shell.ActionMode.OVERVIEW |
            Shell.ActionMode.POPUP;

        for (const [name] of KEYBINDINGS) {
            const handler = handlers[name];
            if (!handler)
                continue;
            Main.wm.addKeybinding(name, settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
                () => handler());
            this._names.push(name);
        }
    }

    destroy() {
        for (const name of this._names)
            Main.wm.removeKeybinding(name);
        this._names = [];
        this._settings = null;
    }
}
