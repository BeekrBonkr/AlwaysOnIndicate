// SPDX-License-Identifier: GPL-3.0-or-later
//
// Presets: whole-look starting points for the preferences.
//
// The extension has well over a hundred settings, which is a lot to face on a
// fresh install. A preset sets every appearance and behavior key at once, so
// picking one gives a coherent look that can then be tweaked.
//
// A preset is applied as "reset everything it manages, then apply its own
// values". That makes it idempotent and order-independent: Minimal after Neon
// looks exactly like Minimal after a fresh install, with no leftover glow.
//
// The keys a preset must never touch are the ones the user configured for
// themselves and could not easily rebuild: keyboard shortcuts, app rules,
// saved window states, the two "what to indicate" toggles, and the decoration
// profiles (those are calibration for the user's theme and window manager,
// not a look).
//
// This module is imported by prefs.js only; nothing here runs in the shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PROTECTED_KEYS = new Set([
    'indicate-above',
    'indicate-sticky',
    'app-rules',
    'rules-apply-to-existing',
    'saved-states',
    'restore-states',
    'radius-when-maximized',
    'active-preset',
]);

const PROTECTED_PREFIXES = ['kb-', 'deco-'];

// One-line summary of what a preset leaves alone, for the UI.
export const PRESET_KEEPS =
    'Your shortcuts, app rules, saved window states, decoration profiles and ' +
    'the two "what to indicate" switches are never changed by a preset.';

export const PRESETS = [
    {
        id: 'balanced',
        name: 'Balanced',
        icon: 'view-pin-symbolic',
        summary: 'The shipped defaults',
        description:
            'A thin outline around pinned windows, a small icon badge in the ' +
            'top-right corner, a top bar indicator with a count and dock badges. ' +
            'Everything is on, nothing is loud.',
        values: {},
    },
    {
        id: 'minimal',
        name: 'Minimal',
        icon: 'media-record-symbolic',
        summary: 'One quiet dot',
        description:
            'No outline at all. A small flat dot sits in the corner of pinned ' +
            'windows and fades back when the window loses focus. The top bar ' +
            'indicator stays, without a count; dock badges are off.',
        values: {
            'outline-enabled': false,
            'badge-style': 'dot',
            'badge-size': 12,
            'badge-shadow': false,
            'badge-opacity': 85,
            'badge-unfocused-opacity': 50,
            'badge-offset-x': 6,
            'badge-offset-y': 6,
            'badge-click-action': 'menu',
            'panel-show-count': false,
            'dock-enabled': false,
            'state-change-feedback': 'none',
        },
    },
    {
        id: 'outline-only',
        name: 'Outline Only',
        icon: 'window-symbolic',
        summary: 'A colored frame, no corner badge',
        description:
            'Nothing is drawn on top of the window contents: pinned windows just ' +
            'get a slightly thicker colored outline. The top bar indicator and ' +
            'dock badges still tell you which windows they are.',
        values: {
            'badge-enabled': false,
            'outline-width': 3,
            'outline-position': 'inside',
            'outline-unfocused-opacity': 70,
        },
    },
    {
        id: 'neon',
        name: 'Neon Glow',
        icon: 'weather-clear-symbolic',
        summary: 'Impossible to miss',
        description:
            'A thick glowing outline with a faint tinted fill, plus a large pill ' +
            'badge that spells the state out in words. Pinned windows flash when ' +
            'their state changes.',
        values: {
            'outline-width': 3,
            'outline-glow': true,
            'outline-glow-size': 14,
            'outline-glow-opacity': 75,
            'outline-fill': true,
            'outline-fill-opacity': 10,
            'badge-style': 'pill',
            'badge-shape': 'rounded',
            'badge-size': 24,
            'badge-border-width': 1,
            'badge-shadow': true,
            'dock-badge-size': 16,
            'flash-on-change': true,
            'animation-interpolation': 'ease-out-back',
        },
    },
    {
        id: 'playful',
        name: 'Playful',
        icon: 'emoji-nature-symbolic',
        summary: 'A badge that runs away',
        description:
            'The badge springs out of the way when the pointer comes near, leans ' +
            'into the turn, and sneaks back once you have moved on. It never takes ' +
            'a click from the window underneath, so it can be as big as it likes.',
        values: {
            'badge-size': 26,
            'badge-shadow': true,
            'badge-click-through': true,
            'badge-hover-fade': true,
            'badge-hover-fade-opacity': 30,
            'badge-dodge': true,
            'badge-dodge-distance': 90,
            'badge-dodge-bounds': 'edge',
            'badge-dodge-duration': 420,
            'badge-dodge-easing': 'ease-out-elastic',
            'badge-dodge-return-delay': 500,
            'badge-dodge-tilt': true,
            'animation-duration': 300,
            'animation-interpolation': 'ease-out-back',
        },
    },
    {
        id: 'out-of-the-way',
        name: 'Out of the Way',
        icon: 'input-mouse-symbolic',
        summary: 'Never covers, never blocks a click',
        description:
            'Indicators appear on the focused window only and disappear entirely ' +
            'on maximized and fullscreen windows. The badge passes clicks through ' +
            'and turns almost invisible the moment the pointer touches it.',
        values: {
            'indicator-visibility': 'focused',
            'hide-when-maximized': true,
            'hide-when-fullscreen': true,
            'outline-width': 1,
            'outline-opacity': 70,
            'badge-size': 14,
            'badge-opacity': 80,
            'badge-shadow': false,
            'badge-click-through': true,
            'badge-hover-grow': false,
            'badge-hover-fade': true,
            'badge-hover-fade-opacity': 10,
            'state-change-feedback': 'none',
        },
    },
    {
        id: 'panel-only',
        name: 'Top Bar Only',
        icon: 'focus-top-bar-symbolic',
        summary: 'Nothing drawn on windows',
        description:
            'No outline and no corner badge. Pinned windows are listed in the top ' +
            'bar menu with a count that stays visible even at zero, and marked in ' +
            'the dock. Best paired with keyboard shortcuts.',
        values: {
            'outline-enabled': false,
            'badge-enabled': false,
            'panel-enabled': true,
            'panel-show-count': true,
            'panel-hide-when-empty': false,
            'dock-badge-show-count': true,
        },
    },
    {
        id: 'high-contrast',
        name: 'High Contrast',
        icon: 'contrast-symbolic',
        summary: 'Large, opaque, unambiguous',
        description:
            'A thick, fully opaque outline and a large labeled badge with a solid ' +
            'border. Nothing dims when a window loses focus and nothing fades ' +
            'under the pointer.',
        values: {
            'outline-width': 4,
            'outline-opacity': 100,
            'outline-unfocused-opacity': 100,
            'badge-style': 'label',
            'badge-shape': 'rounded',
            'badge-size': 28,
            'badge-border-width': 2,
            'badge-shadow': true,
            'badge-opacity': 100,
            'badge-unfocused-opacity': 100,
            'dock-badge-size': 18,
            'panel-color-by-state': true,
        },
    },
    {
        id: 'low-motion',
        name: 'Low Motion',
        icon: 'preferences-system-symbolic',
        summary: 'No animation, no glow',
        description:
            'Indicators appear and vanish instantly. Nothing grows, dodges, ' +
            'flashes or glows, and there is no on-screen message when a state ' +
            'changes. The lightest option to draw.',
        values: {
            'animation-duration': 0,
            'animation-interpolation': 'linear',
            'flash-on-change': false,
            'outline-glow': false,
            'outline-fill': false,
            'badge-hover-grow': false,
            'badge-shadow': false,
            'state-change-feedback': 'none',
        },
    },
];

export function presetById(id) {
    return PRESETS.find(preset => preset.id === id) ?? null;
}

// Every schema key a preset is allowed to write.
export function managedKeys(settings) {
    return settings.settings_schema.list_keys().filter(key =>
        !PROTECTED_KEYS.has(key) &&
        !PROTECTED_PREFIXES.some(prefix => key.startsWith(prefix)));
}

// The value a key should have under a preset: the preset's own override, or
// the schema default when the preset does not mention it.
function expectedValue(settings, preset, key) {
    const fallback = settings.get_default_value(key);
    if (!(key in preset.values))
        return fallback;
    return GLib.Variant.new(fallback.get_type_string(), preset.values[key]);
}

// A snapshot of the managed keys, for undo.
export function snapshot(settings) {
    const values = new Map();
    for (const key of managedKeys(settings))
        values.set(key, settings.get_value(key));
    return values;
}

export function restore(settings, values) {
    writeAtomically(settings, write => {
        for (const [key, value] of values)
            write.set_value(key, value);
    });
}

// Apply a preset: reset every managed key, then write the preset's values.
export function applyPreset(settings, preset) {
    writeAtomically(settings, write => {
        for (const key of managedKeys(settings)) {
            if (key in preset.values)
                write.set_value(key, expectedValue(settings, preset, key));
            else
                write.reset(key);
        }
    });
    settings.set_string('active-preset', preset.id);
}

// Write a batch of keys as one dconf transaction, so the shell never sees a
// half-applied preset. A delayed GSettings queues both writes and resets and
// flushes them together on apply().
function writeAtomically(settings, body) {
    const delayed = new Gio.Settings({settings_schema: settings.settings_schema});
    delayed.delay();
    try {
        body(delayed);
        delayed.apply();
    } catch (e) {
        delayed.revert();
        throw e;
    }
}

export function matchesPreset(settings, preset) {
    return managedKeys(settings).every(key =>
        settings.get_value(key).equal(expectedValue(settings, preset, key)));
}

// What to show in the preset button: the preset whose look is currently in
// effect, or the last one applied plus a "modified" flag once the user has
// changed something it covers. Neither means the settings are the user's own.
export function presetStatus(settings) {
    const exact = PRESETS.find(preset => matchesPreset(settings, preset));
    if (exact)
        return {preset: exact, modified: false};
    const last = presetById(settings.get_string('active-preset'));
    if (last)
        return {preset: last, modified: true};
    return {preset: null, modified: false};
}
