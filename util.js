// SPDX-License-Identifier: GPL-3.0-or-later
//
// Small helpers shared by the extension modules: window state naming,
// color handling, app-rule matching and the easing table.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION);

// GNOME 51 changed PopupMenu.open() from an animation flag to a parameters
// object; open with the full animation on either.
export function openMenu(menu) {
    menu.open(SHELL_MAJOR >= 51 ? {animate: true} : PopupAnimation.FULL);
}

export const ANIMATION_MODES = {
    'linear': Clutter.AnimationMode.LINEAR,
    'ease-in-quad': Clutter.AnimationMode.EASE_IN_QUAD,
    'ease-out-quad': Clutter.AnimationMode.EASE_OUT_QUAD,
    'ease-in-out-quad': Clutter.AnimationMode.EASE_IN_OUT_QUAD,
    'ease-out-cubic': Clutter.AnimationMode.EASE_OUT_CUBIC,
    'ease-in-out-cubic': Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
    'ease-out-quart': Clutter.AnimationMode.EASE_OUT_QUART,
    'ease-out-quint': Clutter.AnimationMode.EASE_OUT_QUINT,
    'ease-out-expo': Clutter.AnimationMode.EASE_OUT_EXPO,
    'ease-in-out-sine': Clutter.AnimationMode.EASE_IN_OUT_SINE,
    'ease-out-circ': Clutter.AnimationMode.EASE_OUT_CIRC,
    'ease-out-back': Clutter.AnimationMode.EASE_OUT_BACK,
    'ease-out-elastic': Clutter.AnimationMode.EASE_OUT_ELASTIC,
    'ease-out-bounce': Clutter.AnimationMode.EASE_OUT_BOUNCE,
};

export function animationMode(settings) {
    return ANIMATION_MODES[settings.get_string('animation-interpolation')] ??
        Clutter.AnimationMode.EASE_OUT_QUAD;
}

// Window types that can meaningfully be pinned by the user. Docks, desktop
// windows, menus and other override-redirect windows are always sticky or
// always above by nature and would only add noise.
const TRACKED_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);

export function isTrackable(window) {
    if (!window || window.is_override_redirect())
        return false;
    return TRACKED_TYPES.has(window.window_type);
}

// Raw state of a window, regardless of what the settings ask to indicate.
export function rawState(window) {
    return {
        above: window.is_above(),
        // Windows that are sticky by nature (docks etc.) are not "pinned".
        sticky: window.is_on_all_workspaces() &&
            !window.is_always_on_all_workspaces(),
    };
}

// The state to indicate: 'above' | 'sticky' | 'both' | null, after applying
// the indicate-above / indicate-sticky settings.
export function indicatedState(window, settings) {
    const {above, sticky} = rawState(window);
    const a = above && settings.get_boolean('indicate-above');
    const s = sticky && settings.get_boolean('indicate-sticky');
    if (a && s)
        return 'both';
    if (a)
        return 'above';
    if (s)
        return 'sticky';
    return null;
}

export function stateLabel(state) {
    switch (state) {
    case 'above': return 'Always on Top';
    case 'sticky': return 'Always on Visible Workspace';
    case 'both': return 'Always on Top and on Visible Workspace';
    default: return 'Not pinned';
    }
}

// Color for a state: either the shared state colors or an indicator's own
// custom colors (prefix e.g. 'outline' → 'outline-color-above').
export function colorFor(settings, state, prefix = null) {
    const usesCustom = prefix &&
        settings.get_string(`${prefix}-color-source`) === 'custom';
    const base = usesCustom ? `${prefix}-color` : 'color';
    return settings.get_string(`${base}-${state}`);
}

export function iconFor(settings, state) {
    return settings.get_string(`icon-${state}`);
}

// '#rrggbb' or '#rrggbbaa' → 'rgba(r, g, b, a)' with an optional opacity
// multiplier (0..1). Falls back to the input for anything unparseable.
export function cssColor(hex, opacity = 1) {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex?.trim() ?? '');
    if (!m)
        return hex;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = (m[2] ? parseInt(m[2], 16) / 255 : 1) * opacity;
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

export function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// App rules

export function parseRules(settings) {
    try {
        const rules = JSON.parse(settings.get_string('app-rules'));
        return Array.isArray(rules) ? rules.filter(r => r && typeof r === 'object') : [];
    } catch {
        return [];
    }
}

export function windowAppId(window) {
    return window.get_gtk_application_id() ??
        window.get_sandboxed_app_id() ??
        Shell.WindowTracker.get_default().get_window_app(window)?.get_id() ??
        '';
}

function fieldValue(window, field) {
    switch (field) {
    case 'title': return window.get_title() ?? '';
    case 'app_id': return windowAppId(window);
    case 'wm_class':
    default:
        return window.get_wm_class() ?? '';
    }
}

export function ruleMatches(rule, window) {
    const match = (rule.match ?? '').trim();
    if (!match)
        return false;
    const value = fieldValue(window, rule.field ?? 'wm_class');
    switch (rule.mode ?? 'contains') {
    case 'exact':
        return value.toLowerCase() === match.toLowerCase();
    case 'regex':
        try {
            return new RegExp(match, 'i').test(value);
        } catch {
            return false;
        }
    case 'contains':
    default:
        return value.toLowerCase().includes(match.toLowerCase());
    }
}

// All rules matching a window, in settings order (later rules win when the
// caller merges them).
export function rulesFor(rules, window) {
    return rules.filter(rule => ruleMatches(rule, window));
}

// Merge the overrides of all matching rules into one object.
export function mergedRule(rules, window) {
    const merged = {};
    for (const rule of rulesFor(rules, window)) {
        for (const [key, value] of Object.entries(rule)) {
            if (['match', 'field', 'mode'].includes(key))
                continue;
            if (value === null || value === undefined || value === '')
                continue;
            merged[key] = value;
        }
    }
    return merged;
}
