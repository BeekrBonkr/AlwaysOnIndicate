// SPDX-License-Identifier: GPL-3.0-or-later
//
// Everything that changes a window's state on the user's behalf, plus the
// feedback (OSD / notification) and the optional save & restore of states
// across shell restarts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {iconFor, indicatedState, parseRules, rawState, rulesFor, stateLabel, windowAppId} from './util.js';

export class Actions {
    constructor(settings, tracker) {
        this._settings = settings;
        this._tracker = tracker;
        this._cycleIndex = -1;
    }

    destroy() {
        this._settings = null;
        this._tracker = null;
    }

    _target(window) {
        return window ?? this._tracker.focusedWindow;
    }

    setAbove(window, above) {
        window = this._target(window);
        if (!window || window.is_above() === above)
            return;
        this._tracker.markExtensionChange(window);
        if (above) {
            window.make_above();
            if (this._settings.get_boolean('raise-on-pin'))
                Main.activateWindow(window);
        } else {
            window.unmake_above();
        }
    }

    setSticky(window, sticky) {
        window = this._target(window);
        if (!window || window.is_on_all_workspaces() === sticky)
            return;
        this._tracker.markExtensionChange(window);
        if (sticky)
            window.stick();
        else
            window.unstick();
    }

    setState(window, {above, sticky}) {
        window = this._target(window);
        if (!window)
            return;
        if (above !== undefined)
            this.setAbove(window, above);
        if (sticky !== undefined)
            this.setSticky(window, sticky);
    }

    toggleAbove(window) {
        window = this._target(window);
        if (window)
            this.setAbove(window, !window.is_above());
    }

    toggleSticky(window) {
        window = this._target(window);
        if (window)
            this.setSticky(window, !window.is_on_all_workspaces());
    }

    // Pinned (either state) → clear both; otherwise set both.
    toggleBoth(window) {
        window = this._target(window);
        if (!window)
            return;
        const {above, sticky} = rawState(window);
        const pinned = above || sticky;
        this.setState(window, {above: !pinned, sticky: !pinned});
    }

    unpin(window) {
        this.setState(window, {above: false, sticky: false});
    }

    unpinAll() {
        for (const window of this._tracker.pinnedWindows)
            this.unpin(window);
    }

    // Activate the next pinned window after the focused one (wrapping).
    cyclePinned(backwards = false) {
        const pinned = this._tracker.pinnedWindows;
        if (pinned.length === 0)
            return;
        const focus = global.display.focus_window;
        let index = pinned.indexOf(focus);
        if (index < 0)
            index = backwards ? 0 : -1;
        index = (index + (backwards ? -1 : 1) + pinned.length) % pinned.length;
        Main.activateWindow(pinned[index]);
    }

    // -----------------------------------------------------------------------
    // Feedback

    feedback(window, newState, oldState, viaExtension) {
        const kind = this._settings.get_string('state-change-feedback');
        if (kind === 'none')
            return;
        if (this._settings.get_boolean('feedback-only-for-shortcuts') && !viaExtension)
            return;

        // Describe what changed, not the whole state, so a single toggle
        // reads naturally ("Always on Top: on").
        const aboveChanged = newState.above !== oldState.above;
        const stickyChanged = newState.sticky !== oldState.sticky;
        let what;
        let on;
        if (aboveChanged && stickyChanged) {
            what = 'Pinned';
            on = newState.above || newState.sticky;
        } else if (aboveChanged) {
            what = 'Always on Top';
            on = newState.above;
        } else if (stickyChanged) {
            what = 'Always on Visible Workspace';
            on = newState.sticky;
        } else {
            return;
        }

        const title = window.get_title() ?? 'Window';
        const state = indicatedState(window, this._settings);
        const iconName = state
            ? iconFor(this._settings, state)
            : this._settings.get_string('panel-icon');
        const text = `${what}: ${on ? 'on' : 'off'}`;

        if (kind === 'osd') {
            let monitor = window.get_monitor();
            if (monitor < 0)
                monitor = Main.layoutManager.primaryIndex;
            const icon = Gio.ThemedIcon.new(iconName);
            const label = `${text} · ${title}`;
            const osd = Main.osdWindowManager;
            // GNOME 50 takes per-monitor levels; 48/49 take a monitor index.
            if (typeof osd.showOne === 'function')
                osd.showOne(monitor, icon, label);
            else
                osd.show(monitor, icon, label);
        } else if (kind === 'notification') {
            Main.notify(text, `${title} · ${stateLabel(state)}`);
        }
    }

    // -----------------------------------------------------------------------
    // App rules: auto-pin on open

    applyRules(window, rules = parseRules(this._settings)) {
        const matching = rulesFor(rules, window);
        if (matching.length === 0)
            return;
        let above;
        let sticky;
        for (const rule of matching) {
            if (rule.autoAbove !== undefined && rule.autoAbove !== null)
                above = !!rule.autoAbove;
            if (rule.autoSticky !== undefined && rule.autoSticky !== null)
                sticky = !!rule.autoSticky;
        }
        if (above === true)
            this.setAbove(window, true);
        if (sticky === true)
            this.setSticky(window, true);
    }

    // -----------------------------------------------------------------------
    // Save & restore across shell restarts (restore-states)

    saveStates() {
        if (!this._settings.get_boolean('restore-states'))
            return;
        const entries = this._tracker.pinnedWindows.map(window => {
            const {above, sticky} = rawState(window);
            return {
                wmClass: window.get_wm_class() ?? '',
                appId: windowAppId(window),
                title: window.get_title() ?? '',
                above, sticky,
            };
        });
        this._settings.set_string('saved-states', JSON.stringify(entries));
    }

    restoreStates() {
        if (!this._settings.get_boolean('restore-states'))
            return;
        let entries;
        try {
            entries = JSON.parse(this._settings.get_string('saved-states'));
        } catch {
            entries = [];
        }
        if (!Array.isArray(entries) || entries.length === 0)
            return;

        const remaining = [...entries];
        for (const window of this._tracker.windows) {
            const wmClass = window.get_wm_class() ?? '';
            const appId = windowAppId(window);
            const title = window.get_title() ?? '';
            const index = remaining.findIndex(e =>
                e.wmClass === wmClass && e.appId === appId && e.title === title);
            if (index < 0)
                continue;
            const [entry] = remaining.splice(index, 1);
            this.setState(window, {above: !!entry.above, sticky: !!entry.sticky});
        }
    }

    // Debounced save, called from the extension on every state change.
    queueSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._saveId = 0;
            if (this._settings)
                this.saveStates();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelQueuedSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
    }
}
