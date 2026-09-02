// SPDX-License-Identifier: GPL-3.0-or-later
//
// Per-window indicators: an outline hugging the window frame and a badge in
// one of its corners.
//
// Layering ("overlay-layer" setting):
//   'window' — the overlay is a child of the window's compositor actor. It
//              moves, scales and fades with the window (minimize, workspace
//              switch, overview previews all clone the actor subtree) and
//              needs no restacking. This is the default.
//   'stage'  — the overlay lives in global.window_group directly above its
//              window actor and is re-stacked on every 'restacked' signal.
//              It ignores window effects (opacity, scaling) and never shows
//              in overview previews.
//
// Geometry always comes from the window's frame rect (the visible frame,
// without client-side shadows), offset by the decoration profile and app
// rules resolved in decorations.js.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {resolveGeometry} from './decorations.js';
import {animationMode, colorFor, cssColor, iconFor, indicatedState, parseRules} from './util.js';

// Settings keys that only need a restyle / re-layout of existing overlays.
const RESTYLE_PREFIXES = ['outline-', 'badge-', 'color-', 'icon-', 'deco-', 'radius-when-'];

// Pointer motion is sampled at most this often for the "hover" visibility
// modes.
const HOVER_SAMPLE_MS = 50;

// The glow is built from concentric translucent rings outside the outline.
// (St's box-shadow paints under the whole box, which would tint the window.)
const GLOW_RINGS = 4;

function isRestyleKey(key) {
    return RESTYLE_PREFIXES.some(prefix => key.startsWith(prefix)) ||
        key === 'app-rules' || key === 'indicator-visibility' ||
        key === 'hide-in-overview' || key === 'hide-when-fullscreen' ||
        key === 'hide-when-maximized' || key === 'indicate-above' ||
        key === 'indicate-sticky';
}

const CORNERS = {
    'top-left': {h: 'start', v: 'start'},
    'top-center': {h: 'center', v: 'start'},
    'top-right': {h: 'end', v: 'start'},
    'bottom-left': {h: 'start', v: 'end'},
    'bottom-center': {h: 'center', v: 'end'},
    'bottom-right': {h: 'end', v: 'end'},
    'left-center': {h: 'start', v: 'center'},
    'right-center': {h: 'end', v: 'center'},
};

// ---------------------------------------------------------------------------

const Badge = GObject.registerClass(
class Badge extends St.Button {
    _init(manager, window) {
        super._init({
            style_class: 'aoi-badge',
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._manager = manager;
        this._window = window;

        this._box = new St.BoxLayout({
            style_class: 'aoi-badge-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({style_class: 'aoi-badge-icon'});
        this._label = new St.Label({
            style_class: 'aoi-badge-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.set_child(this._box);

        this.connect('clicked', () => this._manager.onBadgeClicked(this, this._window));
        this.connect('notify::hover', () => this._updateHover());
    }

    _updateHover() {
        const grow = this._manager.settings.get_boolean('badge-hover-grow') &&
            this._manager.settings.get_string('badge-click-action') !== 'none';
        const scale = this.hover && grow ? 1.15 : 1;
        this.set_pivot_point(0.5, 0.5);
        this.ease({
            scale_x: scale,
            scale_y: scale,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Returns true if the badge has any visible content.
    restyle(state, settings) {
        const style = settings.get_string('badge-style');
        const size = settings.get_int('badge-size');
        const shape = settings.get_string('badge-shape');
        const color = colorFor(settings, state, 'badge');
        const fg = settings.get_string('badge-foreground-color');
        const borderWidth = settings.get_int('badge-border-width');
        const borderColor = settings.get_string('badge-border-color');
        const shadow = settings.get_boolean('badge-shadow');

        const showIcon = style === 'icon' || style === 'pill';
        const showLabel = style === 'pill' || style === 'label';
        this._icon.visible = showIcon;
        this._label.visible = showLabel;
        this._icon.icon_name = iconFor(settings, state);
        this._icon.icon_size = Math.max(4, Math.round(size * 0.66));
        this._label.text = settings.get_string(`badge-label-${state}`);

        let radius;
        switch (shape) {
        case 'square': radius = 0; break;
        case 'rounded': radius = Math.round(size / 4); break;
        case 'circle':
        default: radius = 999; break;
        }

        const fixedSize = !showLabel;
        const css = [
            `background-color: ${cssColor(color)}`,
            `border-radius: ${radius}px`,
            `color: ${cssColor(fg)}`,
            `border: ${borderWidth}px solid ${cssColor(borderColor)}`,
            fixedSize ? `width: ${size}px; height: ${size}px; padding: 0` :
                `height: ${size}px; padding: 0 ${Math.round(size / 3)}px`,
            `font-size: ${Math.max(6, Math.round(size * 0.55))}px`,
            shadow ? 'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45)' : 'box-shadow: none',
        ];
        this.set_style(css.join('; '));
        this.reactive = settings.get_string('badge-click-action') !== 'none';
        this._box.set_style(`spacing: ${Math.round(size / 4)}px`);
        return true;
    }
});

// ---------------------------------------------------------------------------

class WindowIndicator {
    constructor(manager, window) {
        this._manager = manager;
        this._window = window;
        this._actor = window.get_compositor_private();
        this._layer = manager.settings.get_string('overlay-layer');
        this._state = null;
        this._hovered = false;
        this._shown = false;
        this._destroyed = false;
        this._geometry = null;

        this._container = new St.Widget({
            style_class: 'aoi-overlay',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._outline = new St.Widget({
            style_class: 'aoi-outline',
            reactive: false,
        });
        this._badge = new Badge(manager, window);
        this._glowRings = [];
        this._glowThickness = 0;
        this._container.add_child(this._outline);
        this._container.add_child(this._badge);

        if (this._layer === 'window') {
            this._actor.add_child(this._container);
        } else {
            global.window_group.add_child(this._container);
            this._restack();
            this._actor.connectObject('notify::visible',
                () => this._syncVisibility(), this);
        }
        this._actor.connectObject(
            'notify::size', () => this._queueSync(),
            'notify::position', () => this._queueSync(),
            'destroy', () => this._manager.remove(this._window),
            this);

        this._window.connectObject(
            'position-changed', () => this._queueSync(),
            'size-changed', () => this._queueSync(),
            'notify::fullscreen', () => this._queueSync(),
            'notify::maximized-horizontally', () => this._queueSync(),
            'notify::maximized-vertically', () => this._queueSync(),
            'notify::decorated', () => this._queueSync(),
            'notify::title', () => this._queueSync(),
            'notify::wm-class', () => this._queueSync(),
            'notify::appears-focused', () => this._syncVisibility(),
            'notify::minimized', () => this._syncVisibility(),
            this);

        this._badge.connect('style-changed', () => this._queueSync());
        this.update();
    }

    get window() {
        return this._window;
    }

    get hovered() {
        return this._hovered;
    }

    set hovered(value) {
        if (this._hovered === value)
            return;
        this._hovered = value;
        this._syncVisibility();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        this._window.disconnectObject(this);
        this._actor?.disconnectObject(this);
        this._container.remove_all_transitions();
        this._container.destroy();
        this._container = null;
        this._badge = null;
        this._outline = null;
    }

    _restack() {
        if (this._layer !== 'stage' || this._destroyed)
            return;
        if (this._actor.get_parent() === global.window_group)
            global.window_group.set_child_above_sibling(this._container, this._actor);
    }

    restack() {
        this._restack();
    }

    // Recompute state, style and geometry (settings or state changed).
    update() {
        if (this._destroyed)
            return;
        const settings = this._manager.settings;
        this._state = indicatedState(this._window, settings);
        if (this._state) {
            this._geometry = resolveGeometry(this._window, settings, this._manager.rules);
            this._restyle();
            this._sync();
        }
        this._syncVisibility();
    }

    _queueSync() {
        if (this._destroyed || this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._syncId = 0;
            if (!this._destroyed && this._state) {
                this._geometry = resolveGeometry(this._window, this._manager.settings,
                    this._manager.rules);
                this._restyle();
                this._sync();
                this._syncVisibility();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _restyle() {
        const settings = this._manager.settings;
        const state = this._state;
        const geo = this._geometry;

        // --- Outline ---
        const outlineOn = settings.get_boolean('outline-enabled');
        this._outline.visible = outlineOn;
        if (outlineOn) {
            const width = settings.get_int('outline-width');
            const color = colorFor(settings, state, 'outline');
            const focused = this._window.appears_focused;
            const opacity = settings.get_int(
                focused ? 'outline-opacity' : 'outline-unfocused-opacity') / 100;
            const border = cssColor(color, opacity);
            const edges = {
                top: settings.get_boolean('outline-edge-top'),
                right: settings.get_boolean('outline-edge-right'),
                bottom: settings.get_boolean('outline-edge-bottom'),
                left: settings.get_boolean('outline-edge-left'),
            };
            const css = [];
            for (const [edge, on] of Object.entries(edges))
                css.push(`border-${edge}: ${on ? width : 0}px solid ${border}`);
            css.push(`border-top-left-radius: ${geo.radiusTop}px`);
            css.push(`border-top-right-radius: ${geo.radiusTop}px`);
            css.push(`border-bottom-left-radius: ${geo.radiusBottom}px`);
            css.push(`border-bottom-right-radius: ${geo.radiusBottom}px`);
            if (settings.get_boolean('outline-fill')) {
                const fillOpacity = settings.get_int('outline-fill-opacity') / 100;
                css.push(`background-color: ${cssColor(color, fillOpacity)}`);
            } else {
                css.push('background-color: transparent');
            }
            this._outline.set_style(css.join('; '));

            // Glow rings, fading outward
            const glowOn = settings.get_boolean('outline-glow');
            this._ensureGlowRings(glowOn ? GLOW_RINGS : 0);
            if (glowOn) {
                const glowSize = settings.get_int('outline-glow-size');
                const glowOpacity = settings.get_int('outline-glow-opacity') / 100;
                this._glowThickness = Math.max(1, Math.round(glowSize / GLOW_RINGS));
                this._glowRings.forEach((ring, i) => {
                    const alpha = glowOpacity * (1 - i / GLOW_RINGS) * opacity;
                    const d = this._glowThickness * (i + 1);
                    ring.set_style([
                        `border: ${this._glowThickness}px solid ${cssColor(color, alpha)}`,
                        `border-top-left-radius: ${geo.radiusTop + d}px`,
                        `border-top-right-radius: ${geo.radiusTop + d}px`,
                        `border-bottom-left-radius: ${geo.radiusBottom + d}px`,
                        `border-bottom-right-radius: ${geo.radiusBottom + d}px`,
                    ].join('; '));
                });
            }
        } else {
            this._ensureGlowRings(0);
        }

        // --- Badge ---
        const badgeOn = settings.get_boolean('badge-enabled') && !geo.rule.hideBadge;
        this._badge.visible = badgeOn;
        if (badgeOn) {
            this._badge.restyle(state, settings);
            const focused = this._window.appears_focused;
            this._badge.opacity = Math.round(settings.get_int(
                focused ? 'badge-opacity' : 'badge-unfocused-opacity') * 2.55);
        }
    }

    _ensureGlowRings(count) {
        while (this._glowRings.length > count)
            this._glowRings.pop().destroy();
        while (this._glowRings.length < count) {
            const ring = new St.Widget({style_class: 'aoi-glow', reactive: false});
            // Below the outline and badge
            this._container.insert_child_at_index(ring, 0);
            this._glowRings.push(ring);
        }
    }

    // Position and size the overlay from the window's frame rect.
    _sync() {
        if (this._destroyed || !this._state)
            return;
        const settings = this._manager.settings;
        const geo = this._geometry;
        const frame = this._window.get_frame_rect();

        if (this._layer === 'window') {
            const buffer = this._window.get_buffer_rect();
            this._container.set_position(frame.x - buffer.x, frame.y - buffer.y);
        } else {
            this._container.set_position(frame.x, frame.y);
        }
        this._container.set_size(frame.width, frame.height);

        // Outline box relative to the frame
        const width = settings.get_int('outline-width');
        let grow = 0;
        switch (settings.get_string('outline-position')) {
        case 'outside': grow = width; break;
        case 'centered': grow = Math.round(width / 2); break;
        default: grow = 0;
        }
        const inset = geo.inset - grow;
        const outlineW = Math.max(0, frame.width - 2 * inset);
        const outlineH = Math.max(0, frame.height - 2 * inset);
        this._outline.set_position(inset, inset);
        this._outline.set_size(outlineW, outlineH);
        this._glowRings.forEach((ring, i) => {
            const d = this._glowThickness * (i + 1);
            ring.set_position(inset - d, inset - d);
            ring.set_size(outlineW + 2 * d, outlineH + 2 * d);
        });

        // Badge
        if (this._badge.visible) {
            const corner = CORNERS[geo.rule.badgeCorner || settings.get_string('badge-corner')] ??
                CORNERS['top-right'];
            const [, natW] = this._badge.get_preferred_width(-1);
            const [, natH] = this._badge.get_preferred_height(-1);
            const offX = settings.get_int('badge-offset-x') + geo.badgeDx;
            const offY = settings.get_int('badge-offset-y') + geo.badgeDy;

            let x;
            switch (corner.h) {
            case 'start': x = offX; break;
            case 'center': x = Math.round((frame.width - natW) / 2) + geo.badgeDx; break;
            default: x = frame.width - offX - natW;
            }
            let y;
            switch (corner.v) {
            case 'start': y = offY; break;
            case 'center': y = Math.round((frame.height - natH) / 2) + geo.badgeDy; break;
            default: y = frame.height - offY - natH;
            }
            this._badge.set_position(Math.round(x), Math.round(y));
        }
    }

    _shouldShow() {
        if (!this._state || this._manager.hidden)
            return false;
        if (this._geometry?.rule.hide)
            return false;
        const settings = this._manager.settings;
        const window = this._window;
        if (this._layer === 'stage' && !this._actor.visible)
            return false;
        if (window.minimized)
            return false;
        if (settings.get_boolean('hide-in-overview') && Main.overview.visible)
            return false;
        if (settings.get_boolean('hide-when-fullscreen') && window.is_fullscreen())
            return false;
        if (settings.get_boolean('hide-when-maximized') &&
            (window.maximized_horizontally && window.maximized_vertically))
            return false;

        const focused = window.appears_focused;
        switch (settings.get_string('indicator-visibility')) {
        case 'focused': return focused;
        case 'unfocused': return !focused;
        case 'hover': return this._hovered;
        case 'hover-or-focused': return this._hovered || focused;
        default: return true;
        }
    }

    _syncVisibility() {
        if (this._destroyed)
            return;
        const show = this._shouldShow();
        if (show === this._shown)
            return;
        this._shown = show;

        const settings = this._manager.settings;
        const duration = settings.get_int('animation-duration');
        const mode = animationMode(settings);
        this._container.remove_transition('opacity');
        if (show) {
            this._container.show();
            this._container.ease({opacity: 255, duration, mode});
        } else {
            this._container.ease({
                opacity: 0, duration, mode,
                onComplete: () => {
                    if (!this._destroyed && !this._shown)
                        this._container.hide();
                },
            });
        }
    }

    // A short pulse to draw attention when the state changes.
    flash() {
        if (this._destroyed || !this._shown)
            return;
        const settings = this._manager.settings;
        const duration = settings.get_int('flash-duration');
        const half = Math.max(25, Math.round(duration / 2));
        this._container.remove_transition('opacity');
        this._container.ease({
            opacity: 60,
            duration: half,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._destroyed)
                    return;
                this._container.ease({
                    opacity: this._shown ? 255 : 0,
                    duration: half,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    containsPoint(x, y) {
        const frame = this._window.get_frame_rect();
        return x >= frame.x && x < frame.x + frame.width &&
            y >= frame.y && y < frame.y + frame.height;
    }
}

// ---------------------------------------------------------------------------

export class OverlayManager {
    constructor(settings, tracker, actions, extension) {
        this.settings = settings;
        this._tracker = tracker;
        this._actions = actions;
        this._extension = extension;
        this._indicators = new Map(); // Meta.Window → WindowIndicator
        this.rules = parseRules(settings);
        this.hidden = false;
        this._hoverSampleId = 0;
        this._menu = null;
        this._menuManager = null;

        this._tracker.connectObject(
            'state-changed', (_t, window, state, oldState) =>
                this._onStateChanged(window, state, oldState),
            'window-removed', (_t, window) => this.remove(window),
            this);
        this.settings.connectObject('changed', (_s, key) => this._onSettingsChanged(key), this);
        global.display.connectObject('restacked', () => this._restackAll(), this);
        Main.overview.connectObject(
            'showing', () => this._syncAllVisibility(),
            'hidden', () => this._syncAllVisibility(),
            this);

        this._updateHoverTracking();
        for (const window of this._tracker.pinnedWindows)
            this._ensure(window);
    }

    destroy() {
        this._tracker.disconnectObject(this);
        this.settings.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._stopHoverTracking();
        for (const indicator of this._indicators.values())
            indicator.destroy();
        this._indicators.clear();
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
    }

    // Temporarily hide / show every window indicator (shortcut, menu, D-Bus).
    toggleHidden() {
        this.hidden = !this.hidden;
        this._syncAllVisibility();
        return this.hidden;
    }

    setHidden(hidden) {
        if (this.hidden === hidden)
            return;
        this.hidden = hidden;
        this._syncAllVisibility();
    }

    _ensure(window) {
        if (this._indicators.has(window))
            return this._indicators.get(window);
        const actor = window.get_compositor_private();
        if (!actor) {
            // Very early in the window's life; try again once it is shown.
            window.connectObject('shown', () => {
                window.disconnectObject(this);
                if (this._tracker.has(window) && indicatedState(window, this.settings))
                    this._ensure(window);
            }, this);
            return null;
        }
        const indicator = new WindowIndicator(this, window);
        this._indicators.set(window, indicator);
        return indicator;
    }

    remove(window) {
        const indicator = this._indicators.get(window);
        if (!indicator)
            return;
        this._indicators.delete(window);
        indicator.destroy();
    }

    _onStateChanged(window, state) {
        if (state.above || state.sticky) {
            const indicator = this._ensure(window);
            indicator?.update();
            if (this.settings.get_boolean('flash-on-change'))
                indicator?.flash();
        } else {
            // Fade out, then drop the indicator.
            const indicator = this._indicators.get(window);
            if (!indicator)
                return;
            indicator.update();
            const duration = this.settings.get_int('animation-duration');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 20, () => {
                if (this._indicators.get(window) === indicator &&
                    !indicatedState(window, this.settings))
                    this.remove(window);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onSettingsChanged(key) {
        if (key === 'app-rules')
            this.rules = parseRules(this.settings);
        if (key === 'overlay-layer') {
            this._rebuildAll();
            return;
        }
        if (key === 'indicator-visibility')
            this._updateHoverTracking();
        if (isRestyleKey(key)) {
            // Some windows may have become (un)indicated (indicate-* keys)
            for (const window of this._tracker.pinnedWindows)
                this._ensure(window);
            for (const indicator of this._indicators.values())
                indicator.update();
        }
    }

    _rebuildAll() {
        for (const indicator of this._indicators.values())
            indicator.destroy();
        this._indicators.clear();
        for (const window of this._tracker.pinnedWindows)
            this._ensure(window);
    }

    _restackAll() {
        for (const indicator of this._indicators.values())
            indicator.restack();
    }

    _syncAllVisibility() {
        for (const indicator of this._indicators.values())
            indicator._syncVisibility();
    }

    // --- Hover tracking -----------------------------------------------------

    _updateHoverTracking() {
        const mode = this.settings.get_string('indicator-visibility');
        const needed = mode === 'hover' || mode === 'hover-or-focused';
        if (needed && !this._hoverSampleId) {
            this._hoverSampleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                HOVER_SAMPLE_MS, () => {
                    this._sampleHover();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!needed) {
            this._stopHoverTracking();
        }
    }

    _stopHoverTracking() {
        if (this._hoverSampleId) {
            GLib.source_remove(this._hoverSampleId);
            this._hoverSampleId = 0;
        }
        for (const indicator of this._indicators.values())
            indicator.hovered = false;
    }

    _sampleHover() {
        const [x, y] = global.get_pointer();
        // Only the topmost pinned window under the pointer counts as hovered.
        const ordered = [...this._indicators.values()];
        const stacking = new Map();
        global.get_window_actors().forEach((actor, i) => stacking.set(actor.meta_window, i));
        ordered.sort((a, b) => (stacking.get(b.window) ?? 0) - (stacking.get(a.window) ?? 0));
        let found = false;
        for (const indicator of ordered) {
            const hit = !found && indicator.window.showing_on_its_workspace() &&
                indicator.containsPoint(x, y);
            indicator.hovered = hit;
            if (hit)
                found = true;
        }
    }

    // --- Badge clicks ---------------------------------------------------------

    onBadgeClicked(badge, window) {
        switch (this.settings.get_string('badge-click-action')) {
        case 'unpin':
            this._actions.unpin(window);
            break;
        case 'toggle-above':
            this._actions.toggleAbove(window);
            break;
        case 'toggle-sticky':
            this._actions.toggleSticky(window);
            break;
        case 'menu':
            this._openBadgeMenu(badge, window);
            break;
        default:
            break;
        }
    }

    _openBadgeMenu(badge, window) {
        this._menu?.destroy();
        const menu = new PopupMenu.PopupMenu(badge, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(badge);
        this._menuManager.addMenu(menu);

        const title = new PopupMenu.PopupMenuItem(window.get_title() ?? 'Window', {reactive: false});
        title.label.add_style_class_name('aoi-menu-title');
        menu.addMenuItem(title);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const above = new PopupMenu.PopupSwitchMenuItem('Always on Top', window.is_above());
        above.connect('toggled', (_i, state) => this._actions.setAbove(window, state));
        menu.addMenuItem(above);

        const sticky = new PopupMenu.PopupSwitchMenuItem('Always on Visible Workspace',
            window.is_on_all_workspaces());
        sticky.connect('toggled', (_i, state) => this._actions.setSticky(window, state));
        menu.addMenuItem(sticky);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Unpin', () => this._actions.unpin(window));
        menu.addAction('Settings…', () => this._extension.openPreferences());

        menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._menu === menu) {
                        menu.destroy();
                        this._menu = null;
                        this._menuManager = null;
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        menu.open(true);
    }

    // For debugging: which profile a window got.
    profileOf(window) {
        return this._indicators.get(window)?._geometry?.profile ?? null;
    }
}
