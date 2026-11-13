// SPDX-License-Identifier: GPL-3.0-or-later
//
// Top bar indicator: a pin icon (optionally with a count) whose menu lists
// every pinned window with per-window toggles, plus toggles for the focused
// window and a few global actions.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {colorFor, cssColor, iconFor, indicatedState, openMenu, rawState, stateLabel} from './util.js';

// PanelMenu.Button implements vfunc_event only up to GNOME 48 (later
// versions toggle the menu with a click gesture); chaining up when no parent
// class implements it throws.
const PARENT_HANDLES_EVENTS =
    Object.hasOwn(PanelMenu.Button.prototype, 'vfunc_event');

export const PANEL_ROLE = 'always-on-indicate';

const PANEL_KEYS = new Set([
    'panel-icon', 'panel-show-count', 'panel-hide-when-empty',
    'panel-color-by-state', 'color-above', 'color-sticky', 'color-both',
    'indicate-above', 'indicate-sticky',
]);
const REBUILD_KEYS = new Set(['panel-box', 'panel-order']);

// One row per pinned window: app icon, title, workspace, and toggle buttons.
const WindowItem = GObject.registerClass(
class WindowItem extends PopupMenu.PopupBaseMenuItem {
    _init(indicator, window) {
        super._init({style_class: 'aoi-window-item'});
        this._indicator = indicator;
        this._window = window;
        const settings = indicator._settings;

        if (settings.get_boolean('panel-menu-show-app-icons')) {
            const app = Shell.WindowTracker.get_default().get_window_app(window);
            const icon = app
                ? app.create_icon_texture(16)
                : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 16});
            icon.add_style_class_name('aoi-window-item-icon');
            this.add_child(icon);
        }

        const label = new St.Label({
            text: window.get_title() ?? '',
            style_class: 'aoi-window-item-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this.add_child(label);
        this.label_actor = label;

        if (settings.get_boolean('panel-menu-show-workspace') && !window.is_on_all_workspaces()) {
            const ws = window.get_workspace();
            if (ws) {
                this.add_child(new St.Label({
                    text: `${ws.index() + 1}`,
                    style_class: 'aoi-window-item-workspace',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
        }

        const {above, sticky} = rawState(window);
        this._aboveButton = this._toggleButton(iconFor(settings, 'above'),
            'Always on top', above, () => indicator._actions.toggleAbove(window));
        this._stickyButton = this._toggleButton(iconFor(settings, 'sticky'),
            'Always on visible workspace', sticky, () => indicator._actions.toggleSticky(window));
        const unpin = this._toggleButton('edit-clear-symbolic', 'Unpin', false,
            () => indicator._actions.unpin(window));
        unpin.remove_style_class_name('aoi-menu-toggle');
        unpin.add_style_class_name('aoi-menu-unpin');

        this.connect('activate', () => Main.activateWindow(window));
    }

    _toggleButton(iconName, accessibleName, checked, callback) {
        const button = new St.Button({
            style_class: 'aoi-menu-toggle',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (checked)
            button.add_style_pseudo_class('checked');
        button.connect('clicked', () => {
            callback();
            return Clutter.EVENT_STOP;
        });
        this.add_child(button);
        return button;
    }
});

export const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    _init(settings, tracker, actions, overlays, extension) {
        super._init(0.5, 'Always On Indicate', false);
        this._settings = settings;
        this._tracker = tracker;
        this._actions = actions;
        this._overlays = overlays;
        this._extension = extension;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._count = new St.Label({
            style_class: 'aoi-panel-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._count);
        this.add_child(box);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._rebuildMenu();
        });

        this._tracker.connectObject(
            'windows-changed', () => this._update(),
            'state-changed', () => this._update(),
            'focus-changed', () => this._updateIcon(),
            this);
        this._settings.connectObject('changed', (_s, key) => {
            if (PANEL_KEYS.has(key))
                this._update();
        }, this);

        this.connect('destroy', () => {
            this._tracker.disconnectObject(this);
            this._settings.disconnectObject(this);
        });

        this._update();
    }

    // Middle click and scroll on the button itself
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 2) {
            this._middleClick();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.SCROLL &&
            this._settings.get_string('panel-scroll-action') === 'cycle') {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP)
                this._actions.cyclePinned(true);
            else if (direction === Clutter.ScrollDirection.DOWN)
                this._actions.cyclePinned(false);
            else
                return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        }
        return PARENT_HANDLES_EVENTS
            ? super.vfunc_event(event) : Clutter.EVENT_PROPAGATE;
    }

    _middleClick() {
        switch (this._settings.get_string('panel-middle-click-action')) {
        case 'toggle-above': this._actions.toggleAbove(); break;
        case 'toggle-sticky': this._actions.toggleSticky(); break;
        case 'toggle-both': this._actions.toggleBoth(); break;
        case 'unpin-all': this._actions.unpinAll(); break;
        default: break;
        }
    }

    _pinned() {
        return this._tracker.pinnedWindows.filter(w => indicatedState(w, this._settings));
    }

    _update() {
        const pinned = this._pinned();
        this._count.text = `${pinned.length}`;
        this._count.visible = this._settings.get_boolean('panel-show-count') && pinned.length > 0;
        this.visible = pinned.length > 0 || !this._settings.get_boolean('panel-hide-when-empty');
        this._updateIcon();
        // Keep the menu populated at all times: PopupMenu.open() is a no-op
        // on an empty menu, and it is rebuilt again on open anyway to pick up
        // the focused window.
        this._rebuildMenu();
    }

    _updateIcon() {
        this._icon.icon_name = this._settings.get_string('panel-icon');
        const focus = this._tracker.focusedWindow;
        const state = focus && focus.has_focus() ? indicatedState(focus, this._settings) : null;
        if (state && this._settings.get_boolean('panel-color-by-state')) {
            this._icon.set_style(`color: ${cssColor(colorFor(this._settings, state))}`);
            this._icon.icon_name = iconFor(this._settings, state);
        } else {
            this._icon.set_style(null);
        }
    }

    _rebuildMenu() {
        this.menu.removeAll();
        const settings = this._settings;

        // --- Focused window toggles ---
        if (settings.get_boolean('panel-menu-show-focused')) {
            const focus = this._tracker.focusedWindow;
            if (focus) {
                const title = new PopupMenu.PopupMenuItem(focus.get_title() ?? 'Focused window',
                    {reactive: false});
                title.label.add_style_class_name('aoi-menu-title');
                this.menu.addMenuItem(title);

                const above = new PopupMenu.PopupSwitchMenuItem('Always on Top', focus.is_above());
                above.connect('toggled', (_i, state) => this._actions.setAbove(focus, state));
                this.menu.addMenuItem(above);

                const sticky = new PopupMenu.PopupSwitchMenuItem('Always on Visible Workspace',
                    focus.is_on_all_workspaces());
                sticky.connect('toggled', (_i, state) => this._actions.setSticky(focus, state));
                this.menu.addMenuItem(sticky);
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }
        }

        // --- Pinned windows ---
        const pinned = this._pinned();
        if (pinned.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No pinned windows', {reactive: false}));
        } else if (settings.get_boolean('panel-menu-group-by-state')) {
            for (const state of ['above', 'sticky', 'both']) {
                const windows = pinned.filter(w => indicatedState(w, settings) === state);
                if (windows.length === 0)
                    continue;
                const header = new PopupMenu.PopupMenuItem(stateLabel(state), {reactive: false});
                header.label.add_style_class_name('aoi-menu-section');
                header.label.set_style(`color: ${cssColor(colorFor(settings, state))}`);
                this.menu.addMenuItem(header);
                for (const window of windows)
                    this.menu.addMenuItem(new WindowItem(this, window));
            }
        } else {
            for (const window of pinned)
                this.menu.addMenuItem(new WindowItem(this, window));
        }

        // --- Global actions ---
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (pinned.length > 0)
            this.menu.addAction('Unpin All', () => this._actions.unpinAll());
        const hide = new PopupMenu.PopupSwitchMenuItem('Show Window Indicators',
            !this._overlays.hidden);
        hide.connect('toggled', (_i, state) => this._overlays.setHidden(!state));
        this.menu.addMenuItem(hide);
        this.menu.addAction('Settings…', () => this._extension.openPreferences());
    }
});

// Adds the indicator to the panel and re-adds it when its position settings
// change.
export class PanelIndicatorManager {
    constructor(settings, tracker, actions, overlays, extension) {
        this._settings = settings;
        this._args = [settings, tracker, actions, overlays, extension];
        this._indicator = null;

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'panel-enabled' || REBUILD_KEYS.has(key))
                this._rebuild();
        }, this);
        this._rebuild();
    }

    get indicator() {
        return this._indicator;
    }

    openMenu() {
        if (this._indicator?.visible)
            openMenu(this._indicator.menu);
        else
            this._indicator?.menu.toggle();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
    }

    _rebuild() {
        this._indicator?.destroy();
        this._indicator = null;
        if (!this._settings.get_boolean('panel-enabled'))
            return;

        this._indicator = new PanelIndicator(...this._args);
        const box = this._settings.get_string('panel-box');
        let order = this._settings.get_int('panel-order');
        if (order < 0)
            order = Main.panel[`_${box}Box`]?.get_n_children() ?? 0;
        Main.panel.addToStatusArea(PANEL_ROLE, this._indicator, order, box);
    }
}
