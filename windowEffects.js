// SPDX-License-Identifier: GPL-3.0-or-later
//
// Effects applied to the pinned windows themselves (not the indicators):
// currently the opacity of always-on-top windows, focused and unfocused,
// plus per-app opacity from app rules.

import Clutter from 'gi://Clutter';

import {animationMode, mergedRule, parseRules, rawState} from './util.js';

export class WindowEffects {
    constructor(settings, tracker) {
        this._settings = settings;
        this._tracker = tracker;
        this._touched = new Set(); // window actors we changed
        this._rules = parseRules(settings);

        this._tracker.connectObject(
            'state-changed', (_t, window) => this._sync(window),
            'focus-changed', () => this._syncAll(),
            'window-removed', (_t, window) => this._forget(window),
            this);
        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'app-rules')
                this._rules = parseRules(this._settings);
            if (key.endsWith('-opacity') || key === 'app-rules' ||
                key === 'animation-duration' || key === 'animation-interpolation')
                this._syncAll();
        }, this);

        this._syncAll();
    }

    destroy() {
        this._tracker.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const actor of this._touched) {
            actor.remove_all_transitions();
            actor.opacity = 255;
        }
        this._touched.clear();
        this._settings = null;
        this._tracker = null;
    }

    _forget(window) {
        const actor = window.get_compositor_private();
        if (actor)
            this._touched.delete(actor);
    }

    _syncAll() {
        for (const window of this._tracker.windows)
            this._sync(window);
    }

    _targetOpacity(window) {
        const rule = mergedRule(this._rules, window);
        if (typeof rule.opacity === 'number' && rule.opacity > 0)
            return Math.round(Math.min(100, rule.opacity) * 2.55);

        const {above} = rawState(window);
        if (!above)
            return 255;
        const focused = window.has_focus();
        const percent = this._settings.get_int(
            focused ? 'above-focused-opacity' : 'above-unfocused-opacity');
        return Math.round(percent * 2.55);
    }

    _sync(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        const target = this._targetOpacity(window);
        if (target === 255 && !this._touched.has(actor))
            return;

        this._touched.add(actor);
        if (target === 255)
            this._touched.delete(actor);
        if (actor.opacity === target)
            return;

        const duration = this._settings.get_int('animation-duration');
        actor.remove_transition('opacity');
        actor.ease({
            opacity: target,
            duration,
            mode: duration ? animationMode(this._settings) : Clutter.AnimationMode.LINEAR,
        });
    }
}
