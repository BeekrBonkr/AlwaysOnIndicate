// SPDX-License-Identifier: GPL-3.0-or-later
//
// Window decoration profiles.
//
// Different toolkits draw windows differently: GNOME's own server-side
// frames have rounded top corners, libadwaita apps round all four corners
// themselves, GTK3 apps on X11 round only the top ones with a smaller
// radius, and games or borderless players have square edges. The outline
// and badge need to know which they are dealing with so that the outline
// hugs the visible corners and the badge lands where it is expected.
//
// A window is sorted into one of five profiles, each with user-tunable corner
// radii, an outline inset and a badge offset. App rules can override any of
// those per application (see util.js).

import Meta from 'gi://Meta';

import {mergedRule} from './util.js';

export const PROFILES = ['ssd', 'csd', 'x11-ssd', 'x11-csd', 'undecorated'];

export const PROFILE_INFO = {
    'ssd': {
        title: 'Server-side decorations',
        description: 'The frame is drawn by GNOME (mutter): Wayland apps that ask for a system title bar, e.g. mpv, many Qt apps.',
    },
    'csd': {
        title: 'Client-side decorations',
        description: 'The app draws its own frame and shadow: GTK4 / libadwaita apps, GNOME core apps, Firefox with its own title bar.',
    },
    'x11-ssd': {
        title: 'X11 with server-side decorations',
        description: 'XWayland apps with a GNOME title bar: older toolkits, Wine, many Java and Qt apps.',
    },
    'x11-csd': {
        title: 'X11 with client-side decorations',
        description: 'XWayland apps drawing their own frame: GTK3 apps, Electron and Chromium apps with custom title bars.',
    },
    'undecorated': {
        title: 'Undecorated',
        description: 'No frame at all: games, borderless media players, launchers and apps with fully custom window chrome.',
    },
};

export function detectProfile(window) {
    const x11 = window.get_client_type() === Meta.WindowClientType.X11;
    if (window.decorated)
        return x11 ? 'x11-ssd' : 'ssd';

    // Not decorated by mutter: either the client draws its own frame (and
    // usually a shadow around it, which shows up as a buffer larger than the
    // frame) or it has no frame at all.
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    const hasShadowMargins = buffer.width > frame.width || buffer.height > frame.height;
    const isGtkApp = !!window.get_gtk_application_id();
    if (hasShadowMargins || isGtkApp)
        return x11 ? 'x11-csd' : 'csd';
    return 'undecorated';
}

// Tiled windows are maximized vertically, so both are covered by the
// properties (which exist across GNOME 48–50, unlike get_maximize_flags).
export function isMaximizedOrTiled(window) {
    return window.maximized_horizontally || window.maximized_vertically;
}

// Resolve everything geometry-related for a window:
//   {profile, radiusTop, radiusBottom, inset, badgeDx, badgeDy, rule}
// `rules` is the parsed app-rules array.
export function resolveGeometry(window, settings, rules) {
    const profile = detectProfile(window);
    const rule = mergedRule(rules, window);
    const key = suffix => `deco-${profile}-${suffix}`;

    let radiusTop = rule.radiusTop ?? settings.get_int(key('radius-top'));
    let radiusBottom = rule.radiusBottom ?? settings.get_int(key('radius-bottom'));

    const mode = settings.get_string('outline-radius-mode');
    if (mode === 'custom') {
        radiusTop = radiusBottom = settings.get_int('outline-radius');
    } else if (mode === 'none') {
        radiusTop = radiusBottom = 0;
    } else if (window.is_fullscreen()) {
        radiusTop = radiusBottom = 0;
    } else if (isMaximizedOrTiled(window)) {
        radiusTop = radiusBottom = settings.get_int('radius-when-maximized');
    }

    return {
        profile,
        radiusTop,
        radiusBottom,
        inset: (rule.inset ?? settings.get_int(key('inset'))) +
            settings.get_int('outline-inset'),
        badgeDx: rule.badgeDx ?? settings.get_int(key('badge-dx')),
        badgeDy: rule.badgeDy ?? settings.get_int(key('badge-dy')),
        rule,
    };
}
