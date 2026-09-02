// SPDX-License-Identifier: GPL-3.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Actions} from './actions.js';
import {DBusService} from './dbus.js';
import {DockBadges} from './dockBadges.js';
import {Keybindings} from './keybindings.js';
import {OverlayManager} from './overlays.js';
import {PanelIndicatorManager} from './panelIndicator.js';
import {WindowEffects} from './windowEffects.js';
import {WindowTracker} from './windowTracker.js';
import {parseRules} from './util.js';

export default class AlwaysOnIndicateExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Order matters: the tracker is the source of truth everything else
        // subscribes to, actions need the tracker, the visual parts need both.
        this._tracker = new WindowTracker();
        this._actions = new Actions(this._settings, this._tracker);
        this._overlays = new OverlayManager(this._settings, this._tracker, this._actions, this);
        this._effects = new WindowEffects(this._settings, this._tracker);
        this._panel = new PanelIndicatorManager(this._settings, this._tracker,
            this._actions, this._overlays, this);
        this._dock = new DockBadges(this._settings, this._tracker);
        this._dbus = new DBusService(this._tracker, this._actions, {
            toggleIndicators: () => this._overlays.toggleHidden(),
        });
        this._keybindings = new Keybindings(this._settings, {
            'kb-toggle-above': () => this._actions.toggleAbove(),
            'kb-toggle-sticky': () => this._actions.toggleSticky(),
            'kb-toggle-both': () => this._actions.toggleBoth(),
            'kb-unpin-all': () => this._actions.unpinAll(),
            'kb-cycle-pinned': () => this._actions.cyclePinned(),
            'kb-open-menu': () => this._panel.openMenu(),
            'kb-toggle-indicators': () => this._overlays.toggleHidden(),
        });

        this._tracker.connectObject(
            'state-changed', (_t, window, state, oldState, viaExtension) => {
                this._actions.feedback(window, state, oldState, viaExtension);
                this._actions.queueSave();
            },
            'window-added', (_t, window) => this._onWindowAdded(window),
            this);

        // Restore saved states first, then let app rules pin what they want.
        this._actions.restoreStates();
        if (this._settings.get_boolean('rules-apply-to-existing')) {
            const rules = parseRules(this._settings);
            for (const window of this._tracker.windows)
                this._actions.applyRules(window, rules);
        }
    }

    disable() {
        // Save before tearing down (the shell may be restarting or logging out;
        // on lock-screen disable this is harmless).
        this._actions.cancelQueuedSave();
        this._actions.saveStates();

        this._tracker.disconnectObject(this);
        this._keybindings.destroy();
        this._dbus.destroy();
        this._dock.destroy();
        this._panel.destroy();
        this._effects.destroy();
        this._overlays.destroy();
        this._actions.destroy();
        this._tracker.destroy();

        this._keybindings = null;
        this._dbus = null;
        this._dock = null;
        this._panel = null;
        this._effects = null;
        this._overlays = null;
        this._actions = null;
        this._tracker = null;
        this._settings = null;
    }

    _onWindowAdded(window) {
        // New windows: apply auto-pin rules once they have a title / class.
        // Most windows have both at creation; those that don't get a second
        // chance when they are first shown.
        this._actions.applyRules(window);
        if (!window.get_wm_class() && !window.get_title()) {
            window.connectObject('shown', () => {
                window.disconnectObject(this);
                if (this._tracker?.has(window))
                    this._actions.applyRules(window);
            }, this);
        }
    }
}
