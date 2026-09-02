// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keeps an eye on every user window and reports when its "always on top" or
// "always on visible workspace" state changes, no matter who changed it
// (a shortcut handled by mutter, the window menu, this extension, another
// extension or the app itself).
//
// Emits:
//   'window-added'   (window)
//   'window-removed' (window)
//   'state-changed'  (window, newState, oldState, viaExtension)
//   'windows-changed' ()            any change to the set of pinned windows
//   'focus-changed'  (window|null)  focus moved to a (trackable) window

import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {isTrackable, rawState} from './util.js';

// A state change reported within this many ms of an extension action is
// attributed to the extension (used for "feedback only for shortcuts").
const ATTRIBUTION_WINDOW_MS = 300;

export class WindowTracker extends Signals.EventEmitter {
    constructor() {
        super();
        this._windows = new Map(); // Meta.Window → {above, sticky}
        this._lastFocused = null;
        this._pendingAttribution = new Map(); // window → timestamp
        this._destroyed = false;

        global.display.connectObject(
            'window-created', (_display, window) => this._addWindow(window),
            'notify::focus-window', () => this._onFocusChanged(),
            this);

        for (const actor of global.get_window_actors())
            this._addWindow(actor.meta_window);
        this._onFocusChanged();
    }

    destroy() {
        this._destroyed = true;
        global.display.disconnectObject(this);
        for (const window of [...this._windows.keys()])
            window.disconnectObject(this);
        this._windows.clear();
        this._pendingAttribution.clear();
    }

    // All windows currently tracked, in stacking order (bottom → top).
    get windows() {
        const order = new Map();
        global.get_window_actors().forEach((actor, i) => order.set(actor.meta_window, i));
        return [...this._windows.keys()]
            .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }

    // Windows with at least one of the two states set.
    get pinnedWindows() {
        return this.windows.filter(window => {
            const state = this._windows.get(window);
            return state.above || state.sticky;
        });
    }

    stateOf(window) {
        return this._windows.get(window) ?? null;
    }

    has(window) {
        return this._windows.has(window);
    }

    // The focused window if it is trackable, otherwise the last one that was.
    get focusedWindow() {
        const focus = global.display.focus_window;
        if (focus && this._windows.has(focus))
            return focus;
        return this._lastFocused && this._windows.has(this._lastFocused)
            ? this._lastFocused : null;
    }

    // Call right before changing a window's state on behalf of the user, so
    // the resulting 'state-changed' is flagged as coming from the extension.
    markExtensionChange(window) {
        this._pendingAttribution.set(window, GLib.get_monotonic_time());
    }

    _addWindow(window) {
        if (this._destroyed || this._windows.has(window) || !isTrackable(window))
            return;

        const state = rawState(window);
        this._windows.set(window, state);
        window.connectObject(
            'notify::above', () => this._onStateChanged(window),
            'notify::on-all-workspaces', () => this._onStateChanged(window),
            'unmanaged', () => this._removeWindow(window),
            this);

        this.emit('window-added', window);
        if (state.above || state.sticky) {
            this.emit('state-changed', window, state,
                {above: false, sticky: false}, false);
            this.emit('windows-changed');
        }
    }

    _removeWindow(window) {
        const state = this._windows.get(window);
        if (!state)
            return;
        window.disconnectObject(this);
        this._windows.delete(window);
        this._pendingAttribution.delete(window);
        if (this._lastFocused === window)
            this._lastFocused = null;
        this.emit('window-removed', window);
        if (state.above || state.sticky)
            this.emit('windows-changed');
    }

    _onStateChanged(window) {
        const oldState = this._windows.get(window);
        if (!oldState)
            return;
        const newState = rawState(window);
        if (newState.above === oldState.above && newState.sticky === oldState.sticky)
            return;
        this._windows.set(window, newState);

        const marked = this._pendingAttribution.get(window);
        const viaExtension = marked !== undefined &&
            (GLib.get_monotonic_time() - marked) / 1000 < ATTRIBUTION_WINDOW_MS;
        this._pendingAttribution.delete(window);

        this.emit('state-changed', window, newState, oldState, viaExtension);
        this.emit('windows-changed');
    }

    _onFocusChanged() {
        const focus = global.display.focus_window;
        if (focus && this._windows.has(focus))
            this._lastFocused = focus;
        this.emit('focus-changed', focus && this._windows.has(focus) ? focus : null);
    }
}
