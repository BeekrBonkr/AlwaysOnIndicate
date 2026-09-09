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
//
// Pointer-driven badge behaviors (hover fade, dodging) do not rely on the
// badge receiving events — it may be click-through — but on motion events
// captured on the stage, coalesced to one update per frame. Dodging keeps the
// badge's rest position (x/y) untouched and animates a translation on top of
// it, so re-layouts and dodges never fight over the same property.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {resolveGeometry} from './decorations.js';
import {ANIMATION_MODES, animationMode, clamp, colorFor, cssColor, iconFor, indicatedState, parseRules} from './util.js';

// Settings keys that only need a restyle / re-layout of existing overlays.
const RESTYLE_PREFIXES = ['outline-', 'badge-', 'color-', 'icon-', 'deco-', 'radius-when-'];

// Pointer motion is sampled at most this often for the "hover" visibility
// modes.
const HOVER_SAMPLE_MS = 50;

// The glow is built from concentric translucent rings outside the outline.
// (St's box-shadow paints under the whole box, which would tint the window.)
const GLOW_RINGS = 4;

// Pointer motion is coalesced to at most one badge update per this interval.
const POINTER_FLUSH_MS = 16;

// Candidate escape directions tried on each side of the straight-away
// direction when a dodging badge is boxed in (10° steps, up to 180°).
const DODGE_STEPS = 18;

// Extra distance the pointer has to retreat before a dodging badge counts as
// clear, so it does not flicker at the boundary.
const DODGE_HYSTERESIS = 12;

// Maximum lean of a tilting badge in degrees.
const DODGE_MAX_TILT = 22;

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
        const grow = this._manager.settings.get_boolean('badge-hover-grow') && this.reactive;
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
        // A click-through badge (or one with nothing to do) ignores the
        // pointer entirely so clicks reach the window beneath it.
        this.reactive = !settings.get_boolean('badge-click-through') &&
            settings.get_string('badge-click-action') !== 'none';
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

        // Pointer-driven badge behaviors
        this._badgeRest = {x: 0, y: 0};
        this._badgeBaseOpacity = 255;
        this._badgeFaded = false;
        this._dodging = false;
        this._dodgeTarget = null;
        this._dodgeReturnId = 0;

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
        this._cancelDodgeReturn();
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
            this._badgeBaseOpacity = Math.round(settings.get_int(
                focused ? 'badge-opacity' : 'badge-unfocused-opacity') * 2.55);
            if (!settings.get_boolean('badge-hover-fade'))
                this._badgeFaded = false;
            this._applyBadgeOpacity(false);
            if (!settings.get_boolean('badge-dodge'))
                this._endDodge(false);
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
            this._badgeRest = {x: Math.round(x), y: Math.round(y)};
            this._badge.set_position(this._badgeRest.x, this._badgeRest.y);
            // The window moved or resized under the pointer: re-evaluate
            // fade and dodge against the new rest position.
            if (this._manager.pointerTracking)
                this.pointerMoved(...global.get_pointer());
        }
    }

    // --- Pointer-driven badge behaviors ----------------------------------------

    // Called with stage coordinates whenever the pointer moves (or the badge
    // itself moved under a still pointer).
    pointerMoved(stageX, stageY) {
        if (this._destroyed)
            return;
        if (!this._shown || !this._badge.visible) {
            this.resetBadgeEffects();
            return;
        }
        const [ok, x, y] = this._container.transform_stage_point(stageX, stageY);
        if (!ok)
            return;
        const settings = this._manager.settings;
        const badge = this._badge;
        const w = badge.width;
        const h = badge.height;

        if (settings.get_boolean('badge-hover-fade')) {
            const bx = badge.x + badge.translation_x;
            const by = badge.y + badge.translation_y;
            const over = x >= bx && x < bx + w && y >= by && y < by + h;
            this._setBadgeFaded(over);
        } else if (this._badgeFaded) {
            this._setBadgeFaded(false);
        }

        if (settings.get_boolean('badge-dodge'))
            this._updateDodge(x, y, w, h);
        else if (this._dodging)
            this._endDodge(true);
    }

    // Drop every pointer effect immediately (indicator hidden, tracking off).
    resetBadgeEffects() {
        if (this._destroyed)
            return;
        if (this._badgeFaded) {
            this._badgeFaded = false;
            this._applyBadgeOpacity(false);
        }
        this._endDodge(false);
    }

    _setBadgeFaded(faded) {
        if (this._badgeFaded === faded)
            return;
        this._badgeFaded = faded;
        this._applyBadgeOpacity(true);
    }

    _applyBadgeOpacity(animate) {
        const settings = this._manager.settings;
        let opacity = this._badgeBaseOpacity;
        if (this._badgeFaded)
            opacity = Math.round(opacity * settings.get_int('badge-hover-fade-opacity') / 100);
        this._badge.remove_transition('opacity');
        if (animate) {
            this._badge.ease({
                opacity,
                duration: settings.get_int('animation-duration'),
                mode: animationMode(settings),
            });
        } else {
            this._badge.opacity = opacity;
        }
    }

    // Keep the badge at least the dodge distance away from the pointer while
    // staying as close as possible to its rest position. Candidate spots are
    // sampled on the circle around the pointer, preferring the straight-away
    // direction and, among equals, the spot nearest to where the badge is
    // now (so it slides along an edge instead of flipping sides).
    _updateDodge(px, py, w, h) {
        const settings = this._manager.settings;
        const radius = settings.get_int('badge-dodge-distance');
        const rest = this._badgeRest;
        const dx = rest.x + w / 2 - px;
        const dy = rest.y + h / 2 - py;
        const dist = Math.hypot(dx, dy);
        const clearAt = this._dodging ? radius + DODGE_HYSTERESIS : radius;
        if (dist >= clearAt) {
            if (this._dodging)
                this._scheduleDodgeReturn();
            return;
        }
        this._cancelDodgeReturn();
        this._dodging = true;

        const region = this._dodgeRegion(w, h, radius);
        const away = dist > 0.5 ? Math.atan2(dy, dx) : -Math.PI / 2;
        const curX = rest.x + this._badge.translation_x;
        const curY = rest.y + this._badge.translation_y;
        let best = null;
        let bestScore = Infinity;
        for (let step = 0; step <= DODGE_STEPS; step++) {
            for (const sign of step === 0 ? [1] : [1, -1]) {
                const angle = away + sign * step * Math.PI / DODGE_STEPS;
                const x = px + radius * Math.cos(angle) - w / 2;
                const y = py + radius * Math.sin(angle) - h / 2;
                if (x < region.minX || x > region.maxX || y < region.minY || y > region.maxY)
                    continue;
                const score = Math.hypot(x - rest.x, y - rest.y) +
                    0.5 * Math.hypot(x - curX, y - curY);
                if (score < bestScore) {
                    bestScore = score;
                    best = {x, y};
                }
            }
        }
        if (!best) {
            // The allowed area is smaller than the dodge circle: get as far
            // away as the area permits.
            best = {
                x: clamp(px + radius * Math.cos(away) - w / 2, region.minX, region.maxX),
                y: clamp(py + radius * Math.sin(away) - h / 2, region.minY, region.maxY),
            };
        }
        this._moveBadge(Math.round(best.x - rest.x), Math.round(best.y - rest.y));
    }

    // Allowed top-left positions for a dodging badge, in container coordinates.
    _dodgeRegion(w, h, radius) {
        const settings = this._manager.settings;
        const frame = this._window.get_frame_rect();
        let minX, maxX, minY, maxY;
        switch (settings.get_string('badge-dodge-bounds')) {
        case 'window':
            minX = 0;
            minY = 0;
            maxX = frame.width - w;
            maxY = frame.height - h;
            break;
        case 'free':
            minX = -radius;
            minY = -radius;
            maxX = frame.width - w + radius;
            maxY = frame.height - h + radius;
            break;
        case 'edge':
        default:
            minX = -w / 2;
            minY = -h / 2;
            maxX = frame.width - w / 2;
            maxY = frame.height - h / 2;
        }
        // Never leave the monitor the window is on.
        const monitor = global.display.get_monitor_geometry(this._window.get_monitor());
        if (monitor) {
            minX = Math.max(minX, monitor.x - frame.x);
            minY = Math.max(minY, monitor.y - frame.y);
            maxX = Math.min(maxX, monitor.x + monitor.width - frame.x - w);
            maxY = Math.min(maxY, monitor.y + monitor.height - frame.y - h);
        }
        return {
            minX, minY,
            maxX: Math.max(minX, maxX),
            maxY: Math.max(minY, maxY),
        };
    }

    _moveBadge(tx, ty) {
        if (this._dodgeTarget && this._dodgeTarget.x === tx && this._dodgeTarget.y === ty)
            return;
        this._dodgeTarget = {x: tx, y: ty};
        const settings = this._manager.settings;
        const tilt = settings.get_boolean('badge-dodge-tilt') ?
            clamp(tx * 0.25, -DODGE_MAX_TILT, DODGE_MAX_TILT) : 0;
        this._badge.set_pivot_point(0.5, 0.5);
        this._badge.ease({
            translation_x: tx,
            translation_y: ty,
            rotation_angle_z: tilt,
            duration: settings.get_int('badge-dodge-duration'),
            mode: ANIMATION_MODES[settings.get_string('badge-dodge-easing')] ??
                Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _scheduleDodgeReturn() {
        if (this._dodgeReturnId)
            return;
        const delay = this._manager.settings.get_int('badge-dodge-return-delay');
        this._dodgeReturnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._dodgeReturnId = 0;
            this._endDodge(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDodgeReturn() {
        if (this._dodgeReturnId) {
            GLib.source_remove(this._dodgeReturnId);
            this._dodgeReturnId = 0;
        }
    }

    _endDodge(animate) {
        this._cancelDodgeReturn();
        if (!this._dodging && !this._dodgeTarget)
            return;
        this._dodging = false;
        this._dodgeTarget = null;
        if (this._destroyed || !this._badge)
            return;
        const badge = this._badge;
        for (const prop of ['translation_x', 'translation_y', 'rotation_angle_z'])
            badge.remove_transition(prop);
        if (animate) {
            const settings = this._manager.settings;
            badge.ease({
                translation_x: 0,
                translation_y: 0,
                rotation_angle_z: 0,
                duration: settings.get_int('badge-dodge-duration'),
                mode: ANIMATION_MODES[settings.get_string('badge-dodge-easing')] ??
                    Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            badge.translation_x = 0;
            badge.translation_y = 0;
            badge.rotation_angle_z = 0;
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
            this.resetBadgeEffects();
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
        this._pointerFlushId = 0;
        this._pendingPointer = null;
        this.pointerTracking = false;
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
        this._updatePointerTracking();
        for (const window of this._tracker.pinnedWindows)
            this._ensure(window);
    }

    destroy() {
        this._tracker.disconnectObject(this);
        this.settings.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._stopHoverTracking();
        this._stopPointerTracking();
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
        if (key === 'badge-enabled' || key === 'badge-hover-fade' || key === 'badge-dodge')
            this._updatePointerTracking();
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

    // --- Pointer tracking for badge fade / dodge --------------------------------

    _updatePointerTracking() {
        const needed = this.settings.get_boolean('badge-enabled') &&
            (this.settings.get_boolean('badge-hover-fade') ||
             this.settings.get_boolean('badge-dodge'));
        if (needed && !this.pointerTracking) {
            this.pointerTracking = true;
            global.stage.connectObject('captured-event',
                (_stage, event) => this._onCapturedEvent(event), this);
        } else if (!needed) {
            this._stopPointerTracking();
        }
    }

    _stopPointerTracking() {
        if (!this.pointerTracking)
            return;
        this.pointerTracking = false;
        global.stage.disconnectObject(this);
        if (this._pointerFlushId) {
            GLib.source_remove(this._pointerFlushId);
            this._pointerFlushId = 0;
        }
        this._pendingPointer = null;
        for (const indicator of this._indicators.values())
            indicator.resetBadgeEffects();
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.MOTION && type !== Clutter.EventType.ENTER &&
            type !== Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;
        this._pendingPointer = event.get_coords();
        if (!this._pointerFlushId) {
            this._pointerFlushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_FLUSH_MS, () => {
                this._pointerFlushId = 0;
                this._dispatchPointer();
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _dispatchPointer() {
        const pointer = this._pendingPointer;
        this._pendingPointer = null;
        if (!pointer)
            return;
        const [x, y] = pointer;
        for (const indicator of this._indicators.values())
            indicator.pointerMoved(x, y);
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
