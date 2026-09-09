// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    ShortcutRegistry, customShortcuts, extensionShortcuts, gnomeShortcuts, makeShortcutRow,
} from './prefsShortcuts.js';
import {
    PRESETS, PRESET_KEEPS, applyPreset, presetStatus, restore, snapshot,
} from './presets.js';

const KEYBINDINGS = [
    ['kb-toggle-above', 'Toggle always on top', 'For the focused window'],
    ['kb-toggle-sticky', 'Toggle always on visible workspace', 'For the focused window'],
    ['kb-toggle-both', 'Pin / unpin', 'Sets both states, or clears both if either is set'],
    ['kb-unpin-all', 'Unpin all windows', 'Clears both states on every window'],
    ['kb-cycle-pinned', 'Cycle pinned windows', 'Activates the next pinned window'],
    ['kb-open-menu', 'Open the top bar menu', 'Requires the top bar indicator'],
    ['kb-toggle-indicators', 'Hide / show indicators', 'Temporarily hides all window outlines and badges'],
];

const PROFILES = [
    ['ssd', 'Server-side decorations',
        'Frame drawn by GNOME: Wayland apps that ask for a system title bar (mpv, many Qt apps)'],
    ['csd', 'Client-side decorations',
        'App draws its own frame and shadow: GTK4 / libadwaita apps, GNOME core apps'],
    ['x11-ssd', 'X11 with server-side decorations',
        'XWayland apps with a GNOME title bar: Wine, older toolkits, many Java and Qt apps'],
    ['x11-csd', 'X11 with client-side decorations',
        'XWayland apps drawing their own frame: GTK3 apps, Electron and Chromium apps'],
    ['undecorated', 'Undecorated',
        'No frame: games, borderless players, launchers, fully custom window chrome'],
];

const CORNERS = [
    ['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right'],
    ['left-center', 'Left center'], ['right-center', 'Right center'],
];

const EASINGS = [
    ['linear', 'Linear'],
    ['ease-in-quad', 'Ease in (quad)'],
    ['ease-out-quad', 'Ease out (quad)'],
    ['ease-in-out-quad', 'Ease in-out (quad)'],
    ['ease-out-cubic', 'Ease out (cubic)'],
    ['ease-in-out-cubic', 'Ease in-out (cubic)'],
    ['ease-out-quart', 'Ease out (quart)'],
    ['ease-out-quint', 'Ease out (quint)'],
    ['ease-out-expo', 'Ease out (expo)'],
    ['ease-in-out-sine', 'Ease in-out (sine)'],
    ['ease-out-circ', 'Ease out (circ)'],
    ['ease-out-back', 'Overshoot (back)'],
    ['ease-out-elastic', 'Elastic'],
    ['ease-out-bounce', 'Bounce'],
];

const DBUS_NAME = 'org.gnome.Shell';
const DBUS_PATH = '/org/gnome/Shell/Extensions/AlwaysOnIndicate';
const DBUS_IFACE = 'org.gnome.Shell.Extensions.AlwaysOnIndicate';

// [title, subtitle, url] shown on the About page.
const LINKS = [
    ['Always On Indicate on GitHub', 'Source code, issues and releases',
        'https://github.com/BeekrBonkr/AlwaysOnIndicate'],
    ['Report an issue', 'Bugs, feature requests and questions',
        'https://github.com/BeekrBonkr/AlwaysOnIndicate/issues'],
    ['Topbar Tweaks', 'My other extension: a full top bar on every monitor',
        'https://github.com/BeekrBonkr/TopbarTweaks'],
    ['BeekrBonkr on GitHub', 'More of my projects', 'https://github.com/BeekrBonkr'],
];

// ---------------------------------------------------------------------------
// Widget helpers

function bindCombo(settings, key, comboRow, values) {
    comboRow.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    comboRow.connect('notify::selected', () => {
        settings.set_string(key, values[comboRow.selected]);
    });
    settings.connect(`changed::${key}`, () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && index !== comboRow.selected)
            comboRow.selected = index;
    });
}

// choices: [[value, label], ...]
function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? '',
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    bindCombo(settings, key, row, choices.map(([value]) => value));
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({
        title,
        subtitle: subtitle ?? '',
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: step, page_increment: step * 4,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function rgbaToHex(rgba, withAlpha) {
    const to2 = v => Math.round(v * 255).toString(16).padStart(2, '0');
    let hex = `#${to2(rgba.red)}${to2(rgba.green)}${to2(rgba.blue)}`;
    if (withAlpha && rgba.alpha < 1)
        hex += to2(rgba.alpha);
    return hex;
}

function colorRow(settings, key, title, subtitle, withAlpha = true) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? ''});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: withAlpha}),
        valign: Gtk.Align.CENTER,
    });
    const load = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            button.set_rgba(rgba);
    };
    load();
    let updating = false;
    button.connect('notify::rgba', () => {
        if (updating)
            return;
        settings.set_string(key, rgbaToHex(button.get_rgba(), withAlpha));
    });
    settings.connect(`changed::${key}`, () => {
        updating = true;
        load();
        updating = false;
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

let _iconTheme = null;
let _symbolicIconNames = null;

function iconTheme() {
    if (!_iconTheme)
        _iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    return _iconTheme;
}

// Every "-symbolic" icon the current icon theme (and its fallbacks) can
// resolve. Collected once; the list is a few thousand names.
function symbolicIconNames() {
    if (!_symbolicIconNames) {
        _symbolicIconNames = iconTheme().get_icon_names()
            .filter(name => name.endsWith('-symbolic'))
            .sort((a, b) => a.localeCompare(b));
    }
    return _symbolicIconNames;
}

// A text field for an icon name with a live preview, a warning when the
// name is unknown to the icon theme, a reset and a button that opens a
// searchable grid of the installed symbolic icons.
function iconRow(settings, key, title, subtitle) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    const icon = new Gtk.Image({valign: Gtk.Align.CENTER, pixel_size: 20});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: `Reset to the default (${settings.get_default_value(key).unpack()})`,
    });
    reset.connect('clicked', () => settings.reset(key));
    const update = () => {
        const name = settings.get_string(key);
        const known = name !== '' && iconTheme().has_icon(name);
        icon.icon_name = known ? name : 'image-missing-symbolic';
        icon.css_classes = known ? [] : ['error'];
        icon.tooltip_text = known
            ? name
            : name === '' ? 'No icon set' : `"${name}" is not in the icon theme`;
        reset.visible = settings.get_user_value(key) !== null;
    };
    settings.connect(`changed::${key}`, update);
    update();
    row.add_prefix(icon);
    const browse = new Gtk.Button({
        icon_name: 'view-grid-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Browse the icons installed on this system',
    });
    browse.connect('clicked', () => showIconPicker(row, settings, key, title));
    row.add_suffix(reset);
    row.add_suffix(browse);
    if (subtitle)
        row.tooltip_text = subtitle;
    return row;
}

function showIconPicker(parent, settings, key, title) {
    const dialog = new Adw.Dialog({
        title,
        content_width: 640,
        content_height: 620,
    });
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbar);

    const search = new Gtk.SearchEntry({
        placeholder_text: 'Search icon names',
        hexpand: true,
        margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6,
    });
    toolbar.add_top_bar(search);

    const model = Gtk.StringList.new(symbolicIconNames());
    const filter = new Gtk.StringFilter({
        expression: Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string'),
        match_mode: Gtk.StringFilterMatchMode.SUBSTRING,
        ignore_case: true,
    });
    const filtered = new Gtk.FilterListModel({model, filter});
    const selection = new Gtk.SingleSelection({model: filtered, autoselect: false, can_unselect: true});

    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_factory, item) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            width_request: 108,
            margin_top: 8, margin_bottom: 8, margin_start: 4, margin_end: 4,
        });
        box.append(new Gtk.Image({pixel_size: 28}));
        box.append(new Gtk.Label({
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            lines: 2,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 13,
            justify: Gtk.Justification.CENTER,
            css_classes: ['caption'],
        }));
        item.child = box;
    });
    factory.connect('bind', (_factory, item) => {
        const name = item.item.string;
        const box = item.child;
        box.get_first_child().icon_name = name;
        box.get_last_child().label = name.replace(/-symbolic$/, '');
        box.tooltip_text = name;
    });

    const grid = new Gtk.GridView({
        model: selection,
        factory,
        min_columns: 3,
        max_columns: 6,
        single_click_activate: true,
        margin_start: 6, margin_end: 6,
    });
    const choose = name => {
        settings.set_string(key, name);
        dialog.close();
    };
    grid.connect('activate', (_grid, position) => choose(filtered.get_item(position).string));

    const empty = new Adw.StatusPage({
        title: 'No matching icons',
        description: 'Any icon name can still be typed into the field.',
        icon_name: 'edit-find-symbolic',
    });
    const stack = new Gtk.Stack({vexpand: true});
    stack.add_named(new Gtk.ScrolledWindow({child: grid}), 'grid');
    stack.add_named(empty, 'empty');
    toolbar.set_content(stack);

    const count = new Gtk.Label({css_classes: ['dim-label', 'caption'], xalign: 0, hexpand: true});
    const refreshCount = () => {
        const n = filtered.get_n_items();
        count.label = `${n} of ${model.get_n_items()} symbolic icons`;
        stack.visible_child_name = n === 0 ? 'empty' : 'grid';
    };
    filtered.connect('items-changed', refreshCount);
    refreshCount();
    search.connect('search-changed', () => {
        filter.search = search.text;
    });
    search.connect('activate', () => {
        if (filtered.get_n_items() > 0)
            choose(filtered.get_item(0).string);
    });

    const defaultName = settings.get_default_value(key).unpack();
    const useDefault = new Gtk.Button({
        label: `Use Default (${defaultName.replace(/-symbolic$/, '')})`,
        valign: Gtk.Align.CENTER,
    });
    useDefault.connect('clicked', () => choose(defaultName));
    const library = new Gtk.LinkButton({
        label: 'More icons',
        uri: 'https://flathub.org/apps/org.gnome.design.IconLibrary',
        tooltip_text: 'The Icon Library app has the full GNOME symbolic icon set with names ' +
            'to copy; icons it shows that are not installed here can be typed into the field.',
        valign: Gtk.Align.CENTER,
    });
    const footer = new Gtk.Box({
        spacing: 6,
        margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6,
    });
    footer.append(count);
    footer.append(library);
    footer.append(useDefault);
    toolbar.add_bottom_bar(footer);

    dialog.present(parent);
    search.grab_focus();

    // Start at the icon in use so it is visible and selected
    const current = symbolicIconNames().indexOf(settings.get_string(key));
    if (current >= 0) {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            grid.scroll_to(current, Gtk.ListScrollFlags.SELECT, null);
            return GLib.SOURCE_REMOVE;
        });
    }
}

// A row that opens a web page in the default browser when activated.
function linkRow(window, title, subtitle, uri, icon = 'adw-external-link-symbolic') {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: icon, valign: Gtk.Align.CENTER}));
    row.connect('activated', () => {
        new Gtk.UriLauncher({uri}).launch(window.get_root?.() ?? window, null, (launcher, result) => {
            try {
                launcher.launch_finish(result);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Could not open ${uri}: ${e.message}`);
            }
        });
    });
    return row;
}

function group(page, title, description) {
    const g = new Adw.PreferencesGroup({title, description: description ?? ''});
    page.add(g);
    return g;
}

function bindSensitive(settings, key, rows, predicate) {
    const update = () => {
        const on = predicate(settings);
        for (const row of rows)
            row.sensitive = on;
    };
    settings.connect(`changed::${key}`, update);
    update();
}

function isState(key, value) {
    return settings => settings.get_string(key) === value;
}

function isOn(key) {
    return settings => settings.get_boolean(key);
}

// ---------------------------------------------------------------------------
// Preset button
//
// Adw.PreferencesWindow has no public API for adding a header bar widget, so
// the header bar is looked up in the widget tree. If that ever stops working
// the button lands in a group at the top of the General page instead.

function findHeaderBar(widget) {
    if (widget instanceof Adw.HeaderBar)
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findHeaderBar(child);
        if (found)
            return found;
    }
    return null;
}

function presetRow(preset) {
    const box = new Gtk.Box({
        spacing: 12,
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
    });
    box.append(new Gtk.Image({icon_name: preset.icon, pixel_size: 24}));

    const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true});
    const name = new Gtk.Label({label: preset.name, xalign: 0});
    name.add_css_class('heading');
    const summary = new Gtk.Label({label: preset.summary, xalign: 0});
    summary.add_css_class('caption');
    summary.add_css_class('dim-label');
    text.append(name);
    text.append(summary);
    box.append(text);

    const check = new Gtk.Image({
        icon_name: 'object-select-symbolic',
        valign: Gtk.Align.CENTER,
        visible: false,
    });
    box.append(check);

    const row = new Gtk.ListBoxRow({child: box, tooltip_text: preset.description});
    row._preset = preset;
    row._check = check;
    return row;
}

// ---------------------------------------------------------------------------

export default class AlwaysOnIndicatePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        window.set_default_size(760, 720);
        window.search_enabled = true;

        // The preset button belongs in the header bar; the General page takes
        // it only if the header bar could not be found.
        const presetButton = this._buildPresetButton(window, settings);
        const header = findHeaderBar(window);
        if (header)
            header.pack_start(presetButton);

        window.add(this._buildGeneralPage(settings, header ? null : presetButton));
        window.add(this._buildOutlinePage(settings));
        window.add(this._buildBadgePage(settings));
        window.add(this._buildPanelDockPage(settings));
        window.add(this._buildShortcutsPage(settings, window));
        window.add(this._buildWindowsPage(settings, window));
        window.add(this._buildFeedbackPage(settings));
        window.add(this._buildAboutPage(window));
    }

    // ----------------------------------------------------------------- Presets

    // A menu button showing the look currently in effect, with a popover to
    // switch to another one. Applying is undoable from the toast it raises.
    _buildPresetButton(window, settings) {
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        list.add_css_class('boxed-list');
        const rows = PRESETS.map(preset => {
            const row = presetRow(preset);
            list.append(row);
            return row;
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            width_request: 380,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        });
        const blurb = new Gtk.Label({
            label: 'Pick a starting point, then adjust anything you like. ' + PRESET_KEEPS,
            wrap: true, xalign: 0, max_width_chars: 44,
        });
        blurb.add_css_class('caption');
        blurb.add_css_class('dim-label');
        content.append(blurb);

        const scroller = new Gtk.ScrolledWindow({
            propagate_natural_height: true,
            max_content_height: 460,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: list,
        });
        content.append(scroller);

        const popover = new Gtk.Popover({child: content});
        const button = new Gtk.MenuButton({
            popover,
            always_show_arrow: true,
            tooltip_text: 'Choose a preset',
        });

        const refresh = () => {
            const {preset, modified} = presetStatus(settings);
            button.label = preset
                ? (modified ? `${preset.name} (modified)` : preset.name)
                : 'Custom';
            for (const row of rows)
                row._check.visible = !modified && row._preset === preset;
        };

        // Any settings change can make the active preset stop matching.
        // Comparing every key against every preset is cheap but not free, so
        // bursts (dragging a spin button) collapse into one check.
        let pendingId = 0;
        settings.connect('changed', () => {
            if (pendingId)
                return;
            pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 100, () => {
                pendingId = 0;
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
        button.connect('destroy', () => {
            if (pendingId)
                GLib.source_remove(pendingId);
            pendingId = 0;
        });

        list.connect('row-activated', (_list, row) => {
            popover.popdown();
            const before = snapshot(settings);
            applyPreset(settings, row._preset);
            refresh();
            const toast = new Adw.Toast({
                title: `${row._preset.name} applied`,
                button_label: 'Undo',
            });
            toast.connect('button-clicked', () => {
                restore(settings, before);
                settings.set_string('active-preset', '');
                refresh();
            });
            window.add_toast(toast);
        });

        refresh();
        return button;
    }

    // ----------------------------------------------------------------- General

    _buildGeneralPage(settings, presetButton) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'view-pin-symbolic',
        });

        if (presetButton) {
            const presets = group(page, 'Preset', PRESET_KEEPS);
            const row = new Adw.ActionRow({
                title: 'Preset',
                subtitle: 'Start from a ready-made look',
                activatable_widget: presetButton,
            });
            presetButton.valign = Gtk.Align.CENTER;
            row.add_suffix(presetButton);
            presets.add(row);
        }

        const states = group(page, 'What to Indicate',
            'Windows can be "always on top" (they stay above other windows) and ' +
            '"always on visible workspace" (they follow you to every workspace). ' +
            'Both can be set from the window\'s title bar menu or with a shortcut.');
        states.add(switchRow(settings, 'indicate-above', 'Always on top'));
        states.add(switchRow(settings, 'indicate-sticky', 'Always on visible workspace'));

        const colors = group(page, 'State Colors and Icons',
            'Shared by every indicator unless it uses its own colors. Icons are ' +
            'symbolic icon names from the icon theme: use the grid button to browse ' +
            'the icons installed on this system, or type any icon name.');
        colors.add(colorRow(settings, 'color-above', 'Always on top'));
        colors.add(colorRow(settings, 'color-sticky', 'Always on visible workspace'));
        colors.add(colorRow(settings, 'color-both', 'Both'));
        colors.add(iconRow(settings, 'icon-above', 'Icon: always on top'));
        colors.add(iconRow(settings, 'icon-sticky', 'Icon: always on visible workspace'));
        colors.add(iconRow(settings, 'icon-both', 'Icon: both'));

        const visibility = group(page, 'Window Indicators',
            'The outline and the corner badge are drawn on the window itself.');
        visibility.add(comboRow(settings, 'indicator-visibility', 'Show on',
            'Which pinned windows get an outline and badge', [
                ['always', 'Every pinned window'],
                ['focused', 'The focused window only'],
                ['unfocused', 'Unfocused windows only'],
                ['hover', 'The window under the pointer'],
                ['hover-or-focused', 'The focused window and the one under the pointer'],
            ]));
        visibility.add(switchRow(settings, 'hide-in-overview', 'Hide in the overview'));
        visibility.add(switchRow(settings, 'hide-when-fullscreen', 'Hide on fullscreen windows'));
        visibility.add(switchRow(settings, 'hide-when-maximized', 'Hide on maximized windows'));
        visibility.add(comboRow(settings, 'overlay-layer', 'Drawing layer',
            'Attached indicators follow window animations and appear in overview previews; ' +
            'the separate layer ignores window opacity and effects', [
                ['window', 'Attached to the window'],
                ['stage', 'Separate layer above the window'],
            ]));

        return page;
    }

    // ----------------------------------------------------------------- Outline

    _buildOutlinePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Outline',
            icon_name: 'window-new-symbolic',
        });

        const main = group(page, 'Outline', 'A colored border hugging the window frame.');
        main.add(switchRow(settings, 'outline-enabled', 'Show outline'));
        const rows = [];
        rows.push(spinRow(settings, 'outline-width', 'Width', 'Pixels', 1, 32));
        rows.push(comboRow(settings, 'outline-position', 'Position',
            '"Inside" works with every decoration and shows in overview previews', [
                ['inside', 'Inside the frame'],
                ['outside', 'Outside the frame'],
                ['centered', 'Centered on the edge'],
            ]));
        rows.push(spinRow(settings, 'outline-inset', 'Extra inset',
            'Added to the per-decoration inset; negative pushes outward', -32, 64));
        rows.push(spinRow(settings, 'outline-opacity', 'Opacity', 'Percent', 0, 100, 5));
        rows.push(spinRow(settings, 'outline-unfocused-opacity', 'Opacity when unfocused',
            'Percent', 0, 100, 5));
        rows.forEach(r => main.add(r));

        const corners = group(page, 'Corners',
            'Automatic radii come from the decoration profiles on the Windows page.');
        const radiusMode = comboRow(settings, 'outline-radius-mode', 'Corner radius', '', [
            ['auto', 'Match the window decoration'],
            ['custom', 'Custom'],
            ['none', 'Square'],
        ]);
        corners.add(radiusMode);
        const radius = spinRow(settings, 'outline-radius', 'Custom radius', 'Pixels', 0, 64);
        corners.add(radius);
        bindSensitive(settings, 'outline-radius-mode', [radius],
            isState('outline-radius-mode', 'custom'));
        rows.push(radiusMode, radius);

        const colors = group(page, 'Colors');
        const source = comboRow(settings, 'outline-color-source', 'Colors', '', [
            ['state', 'Use the state colors'],
            ['custom', 'Custom colors'],
        ]);
        colors.add(source);
        const customColors = [
            colorRow(settings, 'outline-color-above', 'Always on top'),
            colorRow(settings, 'outline-color-sticky', 'Always on visible workspace'),
            colorRow(settings, 'outline-color-both', 'Both'),
        ];
        customColors.forEach(r => colors.add(r));
        bindSensitive(settings, 'outline-color-source', customColors,
            isState('outline-color-source', 'custom'));
        rows.push(source, ...customColors);

        const edges = group(page, 'Edges',
            'Leave out edges to get e.g. a top bar accent or side rails.');
        const edgeRows = [
            switchRow(settings, 'outline-edge-top', 'Top'),
            switchRow(settings, 'outline-edge-bottom', 'Bottom'),
            switchRow(settings, 'outline-edge-left', 'Left'),
            switchRow(settings, 'outline-edge-right', 'Right'),
        ];
        edgeRows.forEach(r => edges.add(r));
        rows.push(...edgeRows);

        const effects = group(page, 'Effects');
        const glow = switchRow(settings, 'outline-glow', 'Glow', 'A soft halo around the outline');
        const glowSize = spinRow(settings, 'outline-glow-size', 'Glow size', 'Pixels', 1, 64);
        const glowOpacity = spinRow(settings, 'outline-glow-opacity', 'Glow opacity', 'Percent', 0, 100, 5);
        const fill = switchRow(settings, 'outline-fill', 'Tint', 'Wash the whole window with the outline color');
        const fillOpacity = spinRow(settings, 'outline-fill-opacity', 'Tint opacity', 'Percent', 0, 100, 1);
        [glow, glowSize, glowOpacity, fill, fillOpacity].forEach(r => effects.add(r));
        bindSensitive(settings, 'outline-glow', [glowSize, glowOpacity], isOn('outline-glow'));
        bindSensitive(settings, 'outline-fill', [fillOpacity], isOn('outline-fill'));
        rows.push(glow, fill);

        bindSensitive(settings, 'outline-enabled', rows, isOn('outline-enabled'));
        return page;
    }

    // ----------------------------------------------------------------- Badge

    _buildBadgePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Badge',
            icon_name: 'view-reveal-symbolic',
        });

        const main = group(page, 'Corner Badge',
            'A small marker in a corner of the window. Click it to change the window\'s state.');
        main.add(switchRow(settings, 'badge-enabled', 'Show badge'));
        const rows = [];
        rows.push(comboRow(settings, 'badge-style', 'Style', '', [
            ['dot', 'Dot'],
            ['icon', 'Icon'],
            ['pill', 'Icon and label'],
            ['label', 'Label only'],
        ]));
        rows.push(comboRow(settings, 'badge-shape', 'Shape', '', [
            ['circle', 'Circle'],
            ['rounded', 'Rounded square'],
            ['square', 'Square'],
        ]));
        rows.push(spinRow(settings, 'badge-size', 'Size', 'Pixels', 4, 96));
        rows.forEach(r => main.add(r));

        const placement = group(page, 'Placement',
            'Offsets are measured from the anchor edges inward; negative values move the ' +
            'badge outside the window. Per-decoration and per-app offsets are added on the Windows page.');
        const placementRows = [
            comboRow(settings, 'badge-corner', 'Anchor', '', CORNERS),
            spinRow(settings, 'badge-offset-x', 'Horizontal offset', 'Pixels', -256, 1024),
            spinRow(settings, 'badge-offset-y', 'Vertical offset', 'Pixels', -256, 1024),
        ];
        placementRows.forEach(r => placement.add(r));
        rows.push(...placementRows);

        const colors = group(page, 'Colors');
        const source = comboRow(settings, 'badge-color-source', 'Background', '', [
            ['state', 'Use the state colors'],
            ['custom', 'Custom colors'],
        ]);
        colors.add(source);
        const customColors = [
            colorRow(settings, 'badge-color-above', 'Always on top'),
            colorRow(settings, 'badge-color-sticky', 'Always on visible workspace'),
            colorRow(settings, 'badge-color-both', 'Both'),
        ];
        customColors.forEach(r => colors.add(r));
        bindSensitive(settings, 'badge-color-source', customColors,
            isState('badge-color-source', 'custom'));
        const fg = colorRow(settings, 'badge-foreground-color', 'Icon and text color');
        colors.add(fg);
        const opacity = spinRow(settings, 'badge-opacity', 'Opacity', 'Percent', 0, 100, 5);
        const unfocused = spinRow(settings, 'badge-unfocused-opacity', 'Opacity when unfocused', 'Percent', 0, 100, 5);
        colors.add(opacity);
        colors.add(unfocused);
        rows.push(source, ...customColors, fg, opacity, unfocused);

        const border = group(page, 'Border and Shadow');
        const borderWidth = spinRow(settings, 'badge-border-width', 'Border width', 'Pixels', 0, 8);
        const borderColor = colorRow(settings, 'badge-border-color', 'Border color');
        const shadow = switchRow(settings, 'badge-shadow', 'Drop shadow');
        [borderWidth, borderColor, shadow].forEach(r => border.add(r));
        bindSensitive(settings, 'badge-border-width', [borderColor],
            s => s.get_int('badge-border-width') > 0);
        rows.push(borderWidth, shadow);

        const labels = group(page, 'Labels', 'Shown by the "Icon and label" and "Label only" styles.');
        const labelRows = [
            entryRow(settings, 'badge-label-above', 'Always on top'),
            entryRow(settings, 'badge-label-sticky', 'Always on visible workspace'),
            entryRow(settings, 'badge-label-both', 'Both'),
        ];
        labelRows.forEach(r => labels.add(r));
        rows.push(...labelRows);

        const behavior = group(page, 'Pointer Behavior',
            'How the badge reacts to the pointer. A click-through badge never takes ' +
            'clicks away from the window beneath it; fading and dodging work either way.');
        const click = comboRow(settings, 'badge-click-action', 'Click', '', [
            ['menu', 'Open a menu with both toggles'],
            ['unpin', 'Unpin the window'],
            ['toggle-above', 'Toggle always on top'],
            ['toggle-sticky', 'Toggle always on visible workspace'],
            ['none', 'Nothing'],
        ]);
        const clickThrough = switchRow(settings, 'badge-click-through', 'Click through',
            'Clicks on the badge reach the window; the click action is not triggered');
        const grow = switchRow(settings, 'badge-hover-grow', 'Grow on hover',
            'Only while the badge takes clicks');
        const fade = switchRow(settings, 'badge-hover-fade', 'Fade on hover',
            'Turn the badge translucent while the pointer is over it');
        const fadeOpacity = spinRow(settings, 'badge-hover-fade-opacity', 'Faded opacity',
            'Percent of the normal badge opacity', 0, 100, 5);
        [click, clickThrough, grow, fade, fadeOpacity].forEach(r => behavior.add(r));
        bindSensitive(settings, 'badge-click-through', [click],
            s => !s.get_boolean('badge-click-through'));
        bindSensitive(settings, 'badge-hover-fade', [fadeOpacity], isOn('badge-hover-fade'));
        rows.push(click, clickThrough, grow, fade, fadeOpacity);

        const dodge = group(page, 'Dodge the Pointer',
            'The badge playfully slips out of the way when the pointer comes close, ' +
            'keeps its distance while you chase it, and sneaks back to its spot once ' +
            'the pointer has left. A dodging badge is hard to click on purpose.');
        const dodgeOn = switchRow(settings, 'badge-dodge', 'Dodge the pointer');
        const dodgeRows = [
            spinRow(settings, 'badge-dodge-distance', 'Distance',
                'Pixels between the pointer and the badge center that trigger a dodge', 16, 400, 4),
            comboRow(settings, 'badge-dodge-bounds', 'May move',
                'The badge always stays on the monitor', [
                    ['window', 'Inside the window only'],
                    ['edge', 'Halfway over the window edge'],
                    ['free', 'Up to the dodge distance outside the window'],
                ]),
            spinRow(settings, 'badge-dodge-duration', 'Movement duration', 'Milliseconds', 50, 1500, 10),
            comboRow(settings, 'badge-dodge-easing', 'Movement easing',
                '"Overshoot", "Elastic" and "Bounce" give it the most character', EASINGS),
            spinRow(settings, 'badge-dodge-return-delay', 'Return delay',
                'Milliseconds the badge waits before heading back', 0, 3000, 50),
            switchRow(settings, 'badge-dodge-tilt', 'Lean into the dodge',
                'Tilt the badge in the direction it moves'),
        ];
        dodge.add(dodgeOn);
        dodgeRows.forEach(r => dodge.add(r));
        bindSensitive(settings, 'badge-dodge', dodgeRows, isOn('badge-dodge'));
        rows.push(dodgeOn, ...dodgeRows);

        bindSensitive(settings, 'badge-enabled', rows, isOn('badge-enabled'));
        return page;
    }

    // ----------------------------------------------------------------- Panel & dock

    _buildPanelDockPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Bar & Dock',
            icon_name: 'focus-top-bar-symbolic',
        });

        const panel = group(page, 'Top Bar Indicator',
            'A pin in the top bar with a menu of every pinned window.');
        panel.add(switchRow(settings, 'panel-enabled', 'Show in the top bar'));
        const panelRows = [
            comboRow(settings, 'panel-box', 'Area', '', [
                ['left', 'Left'], ['center', 'Center'], ['right', 'Right'],
            ]),
            spinRow(settings, 'panel-order', 'Position in area', '0 = first, -1 = last', -1, 32),
            iconRow(settings, 'panel-icon', 'Icon'),
            switchRow(settings, 'panel-show-count', 'Show the number of pinned windows'),
            switchRow(settings, 'panel-hide-when-empty', 'Hide when nothing is pinned'),
            switchRow(settings, 'panel-color-by-state', 'Reflect the focused window',
                'Use the state icon and color while the focused window is pinned'),
            comboRow(settings, 'panel-middle-click-action', 'Middle click',
                'Applies to the focused window', [
                    ['toggle-above', 'Toggle always on top'],
                    ['toggle-sticky', 'Toggle always on visible workspace'],
                    ['toggle-both', 'Pin / unpin'],
                    ['unpin-all', 'Unpin all windows'],
                    ['none', 'Nothing'],
                ]),
            comboRow(settings, 'panel-scroll-action', 'Scroll', '', [
                ['cycle', 'Cycle through pinned windows'],
                ['none', 'Nothing'],
            ]),
        ];
        panelRows.forEach(r => panel.add(r));

        const menu = group(page, 'Indicator Menu');
        const menuRows = [
            switchRow(settings, 'panel-menu-show-focused', 'Toggles for the focused window'),
            switchRow(settings, 'panel-menu-group-by-state', 'Group windows by state'),
            switchRow(settings, 'panel-menu-show-app-icons', 'App icons'),
            switchRow(settings, 'panel-menu-show-workspace', 'Workspace numbers'),
        ];
        menuRows.forEach(r => menu.add(r));
        bindSensitive(settings, 'panel-enabled', [...panelRows, ...menuRows], isOn('panel-enabled'));

        const dock = group(page, 'Dash and Dock Badge',
            'A badge on the app icon in the overview dash and in Dash to Dock.');
        dock.add(switchRow(settings, 'dock-enabled', 'Show dock badges'));
        const dockRows = [
            comboRow(settings, 'dock-badge-style', 'Style', '', [
                ['icon', 'State icon'], ['dot', 'Dot'],
            ]),
            switchRow(settings, 'dock-badge-show-count', 'Show the number of pinned windows instead'),
            comboRow(settings, 'dock-badge-corner', 'Corner', '', CORNERS.filter(([v]) => !v.includes('center'))),
            spinRow(settings, 'dock-badge-size', 'Size', 'Pixels', 4, 48),
            comboRow(settings, 'dock-badge-color-source', 'Background', '', [
                ['state', 'Use the state colors'], ['custom', 'Custom color'],
            ]),
        ];
        const dockColor = colorRow(settings, 'dock-badge-color', 'Custom color');
        const dockFg = colorRow(settings, 'dock-badge-foreground-color', 'Icon and text color');
        dockRows.forEach(r => dock.add(r));
        dock.add(dockColor);
        dock.add(dockFg);
        bindSensitive(settings, 'dock-badge-color-source', [dockColor],
            isState('dock-badge-color-source', 'custom'));
        bindSensitive(settings, 'dock-enabled', [...dockRows, dockFg], isOn('dock-enabled'));

        return page;
    }

    // ----------------------------------------------------------------- Shortcuts

    _buildShortcutsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'input-keyboard-symbolic',
        });
        const registry = new ShortcutRegistry();

        // GNOME's own shortcuts first: they are what most people already use.
        const gnome = group(page, 'GNOME Shortcuts',
            'Built into GNOME and handled by the window manager itself; they work ' +
            'with or without this extension. Edits are written straight to the ' +
            'system settings, the same as in Settings → Keyboard.');
        const gnomeEntries = gnomeShortcuts();
        if (gnomeEntries.length === 0) {
            gnome.add(new Adw.ActionRow({
                title: 'Not available',
                subtitle: 'The org.gnome.desktop.wm.keybindings schema was not found.',
            }));
        }
        for (const entry of gnomeEntries)
            gnome.add(makeShortcutRow({...entry, registry}));

        const own = group(page, 'Extension Shortcuts',
            'Extra shortcuts provided by this extension. They are unbound by ' +
            'default so they never clash with what you already use.');
        for (const [key, title, subtitle] of KEYBINDINGS) {
            own.add(makeShortcutRow({
                settings, key, isArray: true, title, subtitle, registry,
                label: `Always On Indicate: ${title}`,
            }));
        }

        const custom = customShortcuts();
        if (custom.length > 0) {
            const customGroup = group(page, 'Custom Shortcuts Found on This System',
                'Keyboard shortcuts from Settings → Keyboard → Custom Shortcuts whose ' +
                'name or command mentions these window states (for example a wmctrl, ' +
                'xdotool or gdbus command).');
            for (const entry of custom)
                customGroup.add(makeShortcutRow({...entry, registry}));
        }

        const others = extensionShortcuts(this.uuid);
        if (others.length > 0) {
            const othersGroup = group(page, 'Shortcuts From Other Extensions',
                'Installed extensions with a keyboard shortcut that looks related. ' +
                'Editing here changes that extension\'s setting.');
            for (const entry of others)
                othersGroup.add(makeShortcutRow({...entry, registry}));
        }

        const scripting = group(page, 'Scripting',
            'The extension is scriptable over D-Bus, so any tool that can bind a ' +
            'command (Settings → Keyboard → Custom Shortcuts, a macro pad, a shell ' +
            'script) can toggle windows. Window id 0 means the focused window.');
        const commands = [
            ['Toggle always on top', 'ToggleAbove 0'],
            ['Toggle always on visible workspace', 'ToggleSticky 0'],
            ['Pin / unpin', 'TogglePin 0'],
            ['Unpin all windows', 'UnpinAll'],
            ['Cycle pinned windows', 'CyclePinned'],
            ['Hide / show indicators', 'ToggleIndicators'],
            ['List windows (JSON)', 'ListWindows'],
        ];
        for (const [title, method] of commands) {
            const command = `gdbus call --session --dest ${DBUS_NAME} --object-path ${DBUS_PATH} ` +
                `--method ${DBUS_IFACE}.${method}`;
            const row = new Adw.ActionRow({title, subtitle: command, subtitle_selectable: true});
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Copy command',
            });
            copy.connect('clicked', () => {
                window.get_clipboard().set(command);
                window.add_toast(new Adw.Toast({title: 'Command copied', timeout: 2}));
            });
            row.add_suffix(copy);
            scripting.add(row);
        }

        return page;
    }

    // ----------------------------------------------------------------- Windows

    _buildWindowsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Windows',
            icon_name: 'view-dual-symbolic',
        });

        const behavior = group(page, 'Pinned Windows');
        behavior.add(spinRow(settings, 'above-unfocused-opacity', 'Always-on-top opacity when unfocused',
            'Percent. Lower values let you see what an always-on-top window covers', 10, 100, 5));
        behavior.add(spinRow(settings, 'above-focused-opacity', 'Always-on-top opacity when focused',
            'Percent', 10, 100, 5));
        behavior.add(switchRow(settings, 'raise-on-pin', 'Raise and focus a window when it is made always on top'));
        behavior.add(switchRow(settings, 'restore-states', 'Restore pinned windows after a shell restart',
            'Matches windows by app and title'));
        behavior.add(switchRow(settings, 'rules-apply-to-existing', 'Apply auto-pin rules to already open windows',
            'When the extension starts'));

        const deco = group(page, 'Decoration Profiles',
            'Every window is sorted into one of these profiles so the outline can ' +
            'follow its real corners and the badge can be nudged into place. Values ' +
            'here are defaults; app rules below can override them per application.');
        deco.add(spinRow(settings, 'radius-when-maximized', 'Corner radius when maximized or tiled',
            'Pixels; most toolkits drop rounded corners in these states', 0, 64));
        for (const [profile, title, description] of PROFILES) {
            const expander = new Adw.ExpanderRow({title, subtitle: description});
            expander.add_row(spinRow(settings, `deco-${profile}-radius-top`, 'Top corner radius', 'Pixels', 0, 64));
            expander.add_row(spinRow(settings, `deco-${profile}-radius-bottom`, 'Bottom corner radius', 'Pixels', 0, 64));
            expander.add_row(spinRow(settings, `deco-${profile}-inset`, 'Outline inset',
                'Pixels; negative pushes outward', -32, 64));
            expander.add_row(spinRow(settings, `deco-${profile}-badge-dx`, 'Badge horizontal nudge', 'Pixels', -256, 256));
            expander.add_row(spinRow(settings, `deco-${profile}-badge-dy`, 'Badge vertical nudge', 'Pixels', -256, 256));
            deco.add(expander);
        }

        this._rulesGroup = new RulesGroup(settings, window);
        page.add(this._rulesGroup.group);

        return page;
    }

    // ----------------------------------------------------------------- Feedback

    _buildFeedbackPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Feedback',
            icon_name: 'preferences-system-notifications-symbolic',
        });

        const feedback = group(page, 'State Changes');
        feedback.add(comboRow(settings, 'state-change-feedback', 'When a window is pinned or unpinned', '', [
            ['osd', 'Show an on-screen display'],
            ['notification', 'Show a notification'],
            ['none', 'Nothing'],
        ]));
        feedback.add(switchRow(settings, 'feedback-only-for-shortcuts', 'Only for this extension\'s shortcuts and menus',
            'Stay quiet when the state is changed by GNOME\'s own shortcuts, the window menu or an app'));
        const flash = switchRow(settings, 'flash-on-change', 'Pulse the window indicators');
        const flashDuration = spinRow(settings, 'flash-duration', 'Pulse duration', 'Milliseconds', 50, 3000, 50);
        feedback.add(flash);
        feedback.add(flashDuration);
        bindSensitive(settings, 'flash-on-change', [flashDuration], isOn('flash-on-change'));

        const animation = group(page, 'Animation',
            'Used when indicators appear and disappear and when window opacity changes.');
        animation.add(spinRow(settings, 'animation-duration', 'Duration', 'Milliseconds; 0 disables animations', 0, 2000, 25));
        animation.add(comboRow(settings, 'animation-interpolation', 'Interpolation', 'Easing curve', EASINGS));

        return page;
    }

    // ----------------------------------------------------------------- About

    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const info = group(page, this.metadata.name, this.metadata.description);
        const version = this.metadata['version-name'] ?? this.metadata.version ?? 'development';
        info.add(new Adw.ActionRow({title: 'Version', subtitle: String(version)}));
        info.add(new Adw.ActionRow({title: 'License', subtitle: 'GPL-3.0-or-later'}));

        const links = group(page, 'Links');
        for (const [title, subtitle, uri] of LINKS)
            links.add(linkRow(window, title, subtitle, uri));

        const support = group(page, 'Support',
            'This extension is free and open source, built in my spare time. If it ' +
            'saved you some time or you would like to see it keep getting updates, ' +
            'you can buy me a coffee.');
        support.add(linkRow(window, 'Buy me a coffee on Ko-fi', 'ko-fi.com/bkrbnkr',
            'https://ko-fi.com/bkrbnkr', 'emblem-favorite-symbolic'));

        return page;
    }
}

// ---------------------------------------------------------------------------
// App rules

const FIELDS = [['wm_class', 'Window class'], ['app_id', 'App id'], ['title', 'Title']];
const MODES = [['contains', 'Contains'], ['exact', 'Exact'], ['regex', 'Regular expression']];

class RulesGroup {
    constructor(settings, window) {
        this._settings = settings;
        this._window = window;
        this._rules = this._load();
        this._writing = false;
        this._rows = [];

        this.group = new Adw.PreferencesGroup({
            title: 'App Rules',
            description: 'Per-app overrides: pin windows automatically when they open, ' +
                'hide indicators for an app, or fix the outline radius, inset and ' +
                'badge position for apps with unusual decorations. Later rules win.',
        });

        const buttons = new Gtk.Box({spacing: 6});
        const add = new Gtk.Button({label: 'Add Rule', css_classes: ['flat']});
        add.connect('clicked', () => this._add({match: '', field: 'wm_class', mode: 'contains'}));
        const pick = new Gtk.Button({label: 'Add From Open Window…', css_classes: ['flat']});
        pick.connect('clicked', () => this._pickWindow());
        buttons.append(add);
        buttons.append(pick);
        this.group.set_header_suffix(buttons);

        settings.connect('changed::app-rules', () => {
            if (this._writing)
                return;
            this._rules = this._load();
            this._rebuild();
        });
        this._rebuild();
    }

    _load() {
        try {
            const rules = JSON.parse(this._settings.get_string('app-rules'));
            return Array.isArray(rules) ? rules : [];
        } catch {
            return [];
        }
    }

    _save() {
        this._writing = true;
        this._settings.set_string('app-rules', JSON.stringify(this._rules));
        this._writing = false;
    }

    _rebuild() {
        for (const row of this._rows)
            this.group.remove(row);
        this._rows = [];
        if (this._rules.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No rules yet',
                subtitle: 'Add one manually or pick an open window.',
            });
            this.group.add(empty);
            this._rows.push(empty);
            return;
        }
        this._rules.forEach((rule, index) => {
            const row = this._buildRow(rule, index);
            this.group.add(row);
            this._rows.push(row);
        });
    }

    _add(rule) {
        this._rules.push(rule);
        this._save();
        this._rebuild();
        this._rows[this._rows.length - 1]?.set_expanded(true);
    }

    _remove(index) {
        this._rules.splice(index, 1);
        this._save();
        this._rebuild();
    }

    _summary(rule) {
        const parts = [];
        parts.push(`${FIELDS.find(([v]) => v === (rule.field ?? 'wm_class'))?.[1] ?? 'Window class'} ` +
            `${MODES.find(([v]) => v === (rule.mode ?? 'contains'))?.[1]?.toLowerCase() ?? 'contains'}`);
        if (rule.autoAbove)
            parts.push('auto on top');
        if (rule.autoSticky)
            parts.push('auto sticky');
        if (rule.hide)
            parts.push('no indicators');
        else if (rule.hideBadge)
            parts.push('no badge');
        const overrides = ['radiusTop', 'radiusBottom', 'inset', 'badgeDx', 'badgeDy', 'opacity']
            .filter(k => typeof rule[k] === 'number').length;
        if (overrides > 0)
            parts.push(`${overrides} geometry override${overrides > 1 ? 's' : ''}`);
        if (rule.badgeCorner)
            parts.push('badge corner');
        return parts.join(' · ');
    }

    _buildRow(rule, index) {
        const expander = new Adw.ExpanderRow({
            title: rule.match || 'New rule',
            subtitle: this._summary(rule),
        });
        const refresh = () => {
            expander.title = rule.match || 'New rule';
            expander.subtitle = this._summary(rule);
            this._save();
        };

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Remove rule',
        });
        remove.connect('clicked', () => this._remove(index));
        expander.add_suffix(remove);

        // --- Matching ---
        const match = new Adw.EntryRow({title: 'Match', text: rule.match ?? ''});
        match.connect('changed', () => {
            rule.match = match.text;
            refresh();
        });
        expander.add_row(match);

        const field = new Adw.ComboRow({
            title: 'Field',
            subtitle: 'Window class is the most stable choice; pick a window below to see its values',
            model: Gtk.StringList.new(FIELDS.map(([, l]) => l)),
            selected: Math.max(0, FIELDS.findIndex(([v]) => v === (rule.field ?? 'wm_class'))),
        });
        field.connect('notify::selected', () => {
            rule.field = FIELDS[field.selected][0];
            refresh();
        });
        expander.add_row(field);

        const mode = new Adw.ComboRow({
            title: 'Comparison',
            model: Gtk.StringList.new(MODES.map(([, l]) => l)),
            selected: Math.max(0, MODES.findIndex(([v]) => v === (rule.mode ?? 'contains'))),
        });
        mode.connect('notify::selected', () => {
            rule.mode = MODES[mode.selected][0];
            refresh();
        });
        expander.add_row(mode);

        // --- Automatic states ---
        const boolRow = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle: subtitle ?? '', active: !!rule[key]});
            row.connect('notify::active', () => {
                if (row.active)
                    rule[key] = true;
                else
                    delete rule[key];
                refresh();
            });
            expander.add_row(row);
            return row;
        };
        boolRow('autoAbove', 'Always on top when opened');
        boolRow('autoSticky', 'Always on visible workspace when opened');
        boolRow('hide', 'Never show window indicators', 'The window still counts in the top bar and dock');
        boolRow('hideBadge', 'Hide the badge only');

        const cornerChoices = [['', 'Default'], ...CORNERS];
        const corner = new Adw.ComboRow({
            title: 'Badge anchor',
            model: Gtk.StringList.new(cornerChoices.map(([, l]) => l)),
            selected: Math.max(0, cornerChoices.findIndex(([v]) => v === (rule.badgeCorner ?? ''))),
        });
        corner.connect('notify::selected', () => {
            const value = cornerChoices[corner.selected][0];
            if (value)
                rule.badgeCorner = value;
            else
                delete rule.badgeCorner;
            refresh();
        });
        expander.add_row(corner);

        // --- Numeric overrides ---
        const overrideRow = (key, title, subtitle, lower, upper) => {
            const row = new Adw.ActionRow({title, subtitle: subtitle ?? ''});
            const check = new Gtk.CheckButton({
                valign: Gtk.Align.CENTER,
                active: typeof rule[key] === 'number',
                tooltip_text: 'Override',
            });
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 4}),
                valign: Gtk.Align.CENTER,
                value: typeof rule[key] === 'number' ? rule[key] : 0,
                sensitive: check.active,
            });
            check.connect('toggled', () => {
                spin.sensitive = check.active;
                if (check.active)
                    rule[key] = spin.get_value_as_int();
                else
                    delete rule[key];
                refresh();
            });
            spin.connect('value-changed', () => {
                if (check.active) {
                    rule[key] = spin.get_value_as_int();
                    refresh();
                }
            });
            row.add_prefix(check);
            row.add_suffix(spin);
            row.activatable_widget = check;
            expander.add_row(row);
        };
        overrideRow('radiusTop', 'Top corner radius', 'Pixels', 0, 64);
        overrideRow('radiusBottom', 'Bottom corner radius', 'Pixels', 0, 64);
        overrideRow('inset', 'Outline inset', 'Pixels; negative pushes outward', -32, 64);
        overrideRow('badgeDx', 'Badge horizontal nudge', 'Pixels', -256, 256);
        overrideRow('badgeDy', 'Badge vertical nudge', 'Pixels', -256, 256);
        overrideRow('opacity', 'Window opacity', 'Percent, applied whether or not the window is pinned', 10, 100);

        return expander;
    }

    // --- Window picker ---------------------------------------------------------

    _pickWindow() {
        const dialog = new Adw.Dialog({
            title: 'Pick an Open Window',
            content_width: 520,
            content_height: 560,
        });
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_child(toolbar);

        const status = new Adw.StatusPage({
            title: 'Looking for windows…',
            icon_name: 'view-dual-symbolic',
        });
        toolbar.set_content(status);
        dialog.present(this._window);

        Gio.DBus.session.call(
            DBUS_NAME, DBUS_PATH, DBUS_IFACE, 'ListWindows',
            null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 3000, null,
            (connection, result) => {
                let windows;
                try {
                    const [json] = connection.call_finish(result).deepUnpack();
                    windows = JSON.parse(json);
                } catch (e) {
                    status.title = 'The extension is not running';
                    status.description = 'Enable Always On Indicate, then try again.\n' +
                        `(${e.message})`;
                    return;
                }
                if (windows.length === 0) {
                    status.title = 'No windows open';
                    status.description = 'Open the app you want a rule for, then try again.';
                    return;
                }

                const list = new Gtk.ListBox({
                    selection_mode: Gtk.SelectionMode.NONE,
                    css_classes: ['boxed-list'],
                    margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
                    valign: Gtk.Align.START,
                });
                windows.sort((a, b) => a.wm_class.localeCompare(b.wm_class));
                for (const w of windows) {
                    const row = new Adw.ActionRow({
                        title: w.title || w.wm_class || '(untitled)',
                        subtitle: `class: ${w.wm_class || '?'} · app id: ${w.app_id || '?'} · ` +
                            `${PROFILES.find(([p]) => p === w.profile)?.[1] ?? w.profile} · ${w.client}`,
                        activatable: true,
                    });
                    const badges = [];
                    if (w.above)
                        badges.push('on top');
                    if (w.sticky)
                        badges.push('sticky');
                    if (badges.length > 0) {
                        row.add_suffix(new Gtk.Label({
                            label: badges.join(', '),
                            css_classes: ['dim-label'],
                            valign: Gtk.Align.CENTER,
                        }));
                    }
                    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                    row.connect('activated', () => {
                        const useClass = !!w.wm_class;
                        this._add({
                            match: useClass ? w.wm_class : w.app_id || w.title,
                            field: useClass ? 'wm_class' : w.app_id ? 'app_id' : 'title',
                            mode: 'exact',
                        });
                        dialog.close();
                    });
                    list.append(row);
                }
                const scroller = new Gtk.ScrolledWindow({child: list, vexpand: true});
                toolbar.set_content(scroller);
            });
    }
}
