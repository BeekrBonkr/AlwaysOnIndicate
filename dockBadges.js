// SPDX-License-Identifier: GPL-3.0-or-later
//
// Badges on app icons in the overview dash and in docks that reuse the
// shell's dash (Dash to Dock and forks expose their dash as `.dash` on a
// chrome actor with the same `_box` of DashItemContainers).
//
// A badge is a small St.Bin dropped into the AppIcon's icon container (a
// BinLayout), aligned to a corner; it shows a state icon or the number of
// pinned windows of that app.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {colorFor, cssColor, iconFor, indicatedState, rawState} from './util.js';

const DOCK_KEYS = ['dock-', 'color-', 'icon-', 'indicate-'];

const ALIGN = {
    'top-left': [Clutter.ActorAlign.START, Clutter.ActorAlign.START],
    'top-right': [Clutter.ActorAlign.END, Clutter.ActorAlign.START],
    'bottom-left': [Clutter.ActorAlign.START, Clutter.ActorAlign.END],
    'bottom-right': [Clutter.ActorAlign.END, Clutter.ActorAlign.END],
};

export class DockBadges {
    constructor(settings, tracker) {
        this._settings = settings;
        this._tracker = tracker;
        this._badges = new Map(); // AppIcon → St.Bin
        this._boxes = new Set();  // dash `_box` actors we watch
        this._scanId = 0;

        this._tracker.connectObject('windows-changed', () => this._updateAll(), this);
        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'dock-enabled') {
                this._destroyBadges();
                this._queueScan();
            } else if (DOCK_KEYS.some(prefix => key.startsWith(prefix))) {
                this._updateAll();
            }
        }, this);
        Main.extensionManager.connectObject('extension-state-changed',
            () => this._queueScan(300), this);
        Main.layoutManager.uiGroup.connectObject('child-added',
            () => this._queueScan(300), this);
        Main.overview.connectObject('showing', () => this._queueScan(), this);

        this._queueScan();
        // Docks created by other extensions may show up a little later.
        this._queueScan(2000);
    }

    destroy() {
        this._tracker.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.overview.disconnectObject(this);
        if (this._scanId) {
            GLib.source_remove(this._scanId);
            this._scanId = 0;
        }
        for (const box of this._boxes)
            box.disconnectObject(this);
        this._boxes.clear();
        this._destroyBadges();
    }

    _destroyBadges() {
        for (const [icon, badge] of this._badges) {
            icon.disconnectObject(this);
            badge.destroy();
        }
        this._badges.clear();
    }

    _queueScan(delay = 50) {
        if (this._scanId)
            return;
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._scanId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dashBoxes() {
        const boxes = new Set();
        const mainBox = Main.overview.dash?._box;
        if (mainBox)
            boxes.add(mainBox);
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            const box = child.dash?._box;
            if (box)
                boxes.add(box);
        }
        return boxes;
    }

    _scan() {
        if (!this._settings.get_boolean('dock-enabled'))
            return;
        for (const box of this._dashBoxes()) {
            if (!this._boxes.has(box)) {
                this._boxes.add(box);
                box.connectObject(
                    'child-added', () => this._queueScan(),
                    'destroy', () => this._boxes.delete(box),
                    this);
            }
            for (const item of box.get_children()) {
                const icon = item.child;
                if (icon?.app && icon._iconContainer)
                    this._ensureBadge(icon);
                else if (item.connectObject && !item._aoiWatched) {
                    // The DashItemContainer gets its child a little later
                    item._aoiWatched = true;
                    item.connectObject('child-added', () => this._queueScan(), this);
                }
            }
        }
        this._updateAll();
    }

    _ensureBadge(icon) {
        if (this._badges.has(icon))
            return;
        const badge = new St.Bin({
            style_class: 'aoi-dock-badge',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        icon._iconContainer.add_child(badge);
        this._badges.set(icon, badge);
        icon.connectObject('destroy', () => {
            this._badges.delete(icon);
        }, this);
    }

    // Aggregate state of an app's pinned windows.
    _appState(app) {
        const settings = this._settings;
        let above = false;
        let sticky = false;
        let count = 0;
        for (const window of app.get_windows()) {
            if (!this._tracker.has(window))
                continue;
            const state = indicatedState(window, settings);
            if (!state)
                continue;
            count++;
            const raw = rawState(window);
            above ||= raw.above && settings.get_boolean('indicate-above');
            sticky ||= raw.sticky && settings.get_boolean('indicate-sticky');
        }
        if (count === 0)
            return null;
        return {state: above && sticky ? 'both' : above ? 'above' : 'sticky', count};
    }

    _updateAll() {
        const settings = this._settings;
        const enabled = settings.get_boolean('dock-enabled');
        const size = settings.get_int('dock-badge-size');
        const [xAlign, yAlign] = ALIGN[settings.get_string('dock-badge-corner')] ?? ALIGN['top-right'];
        const style = settings.get_string('dock-badge-style');
        const showCount = settings.get_boolean('dock-badge-show-count');
        const fg = settings.get_string('dock-badge-foreground-color');

        for (const [icon, badge] of this._badges) {
            const info = enabled && icon.app ? this._appState(icon.app) : null;
            if (!info) {
                badge.hide();
                continue;
            }
            const color = settings.get_string('dock-badge-color-source') === 'custom'
                ? settings.get_string('dock-badge-color')
                : colorFor(settings, info.state);

            badge.x_align = xAlign;
            badge.y_align = yAlign;
            let child;
            if (showCount) {
                child = new St.Label({
                    text: `${info.count}`,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            } else if (style === 'icon') {
                child = new St.Icon({
                    icon_name: iconFor(settings, info.state),
                    icon_size: Math.max(4, Math.round(size * 0.7)),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            } else {
                child = null;
            }
            badge.set_child(child);
            badge.set_style([
                `background-color: ${cssColor(color)}`,
                `color: ${cssColor(fg)}`,
                `width: ${size}px`,
                `height: ${size}px`,
                `border-radius: ${Math.ceil(size / 2)}px`,
                `font-size: ${Math.max(6, Math.round(size * 0.6))}px`,
            ].join('; '));
            badge.show();
        }
    }
}
