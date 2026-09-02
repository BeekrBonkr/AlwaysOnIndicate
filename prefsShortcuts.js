// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shortcut editing for the preferences window:
//   - a row that shows an accelerator and opens a capture dialog on click,
//   - a registry of every editable shortcut so conflicts can be pointed out,
//   - discovery of shortcuts already configured elsewhere on the system that
//     toggle "always on top" / "always on visible workspace":
//       * GNOME's own org.gnome.desktop.wm.keybindings,
//       * custom shortcuts (gnome-settings-daemon media-keys) whose name or
//         command mentions these states (wmctrl, xdotool, gdbus …),
//       * other installed extensions with a matching keybinding key.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const KEYBINDING_NAME_RE = /above|on-?top|ontop|stick|all-?workspaces|always|pin/i;
const COMMAND_RE = /above|on.?top|stick|workspace|pin|always|AlwaysOnIndicate/i;

// ---------------------------------------------------------------------------
// Accelerator helpers

export function normalizeAccelerator(accel) {
    if (!accel)
        return '';
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    if (!ok || (keyval === 0 && mods === 0))
        return accel;
    return Gtk.accelerator_name(keyval, mods);
}

function readAccelerator(settings, key, isArray) {
    if (isArray) {
        const value = settings.get_strv(key);
        return value.length > 0 ? value[0] : '';
    }
    return settings.get_string(key);
}

function writeAccelerator(settings, key, isArray, accel) {
    if (isArray)
        settings.set_strv(key, accel ? [accel] : []);
    else
        settings.set_string(key, accel ?? '');
}

// ---------------------------------------------------------------------------
// Registry: every shortcut the page knows about, for conflict detection

export class ShortcutRegistry {
    constructor() {
        this._entries = [];
    }

    add(entry) {
        this._entries.push(entry);
        return entry;
    }

    conflicts(accel, except) {
        const wanted = normalizeAccelerator(accel);
        if (!wanted)
            return [];
        return this._entries.filter(entry => {
            if (entry === except)
                return false;
            if (!entry.settings.settings_schema.has_key(entry.key))
                return false;
            const values = entry.isArray
                ? entry.settings.get_strv(entry.key)
                : [entry.settings.get_string(entry.key)];
            return values.some(v => normalizeAccelerator(v) === wanted);
        });
    }
}

// ---------------------------------------------------------------------------
// Capture dialog

const ShortcutDialog = GObject.registerClass({
    Signals: {'chosen': {param_types: [GObject.TYPE_STRING]}},
}, class ShortcutDialog extends Adw.Window {
    _init(parent, title, registry, entry) {
        super._init({
            title,
            transient_for: parent,
            modal: true,
            default_width: 420,
            default_height: 240,
            resizable: false,
        });
        this._registry = registry;
        this._entry = entry;
        this._pending = null;

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar({show_title: false}));
        this.set_content(toolbar);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12, margin_bottom: 24, margin_start: 24, margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        toolbar.set_content(box);

        box.append(new Gtk.Label({label: title, css_classes: ['title-2']}));
        this._hint = new Gtk.Label({
            label: 'Press a key combination.\nBackspace clears the shortcut, Escape cancels.',
            justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label'],
            wrap: true,
        });
        box.append(this._hint);

        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: '…',
            halign: Gtk.Align.CENTER,
        });
        box.append(this._shortcutLabel);

        this._conflictLabel = new Gtk.Label({
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ['warning'],
            visible: false,
        });
        box.append(this._conflictLabel);

        const buttons = new Gtk.Box({
            spacing: 12,
            halign: Gtk.Align.CENTER,
            visible: false,
        });
        this._buttons = buttons;
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        const useAnyway = new Gtk.Button({label: 'Use Anyway', css_classes: ['destructive-action']});
        useAnyway.connect('clicked', () => this._choose(this._pending));
        buttons.append(cancel);
        buttons.append(useAnyway);
        box.append(buttons);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) =>
            this._onKeyPressed(keyval, keycode, state));
        this.add_controller(controller);
    }

    _onKeyPressed(keyval, keycode, state) {
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (mask === 0) {
            if (keyval === Gdk.KEY_Escape) {
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this._choose('');
                return Gdk.EVENT_STOP;
            }
        }

        // Ignore bare modifier presses
        if (keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R ||
            keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
            keyval === Gdk.KEY_Alt_L || keyval === Gdk.KEY_Alt_R ||
            keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R ||
            keyval === Gdk.KEY_Meta_L || keyval === Gdk.KEY_Meta_R ||
            keyval === Gdk.KEY_Hyper_L || keyval === Gdk.KEY_Hyper_R ||
            keyval === Gdk.KEY_ISO_Level3_Shift || keyval === Gdk.KEY_Caps_Lock)
            return Gdk.EVENT_STOP;

        if (!Gtk.accelerator_valid(keyval, mask))
            return Gdk.EVENT_STOP;

        const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
        this._shortcutLabel.accelerator = accel;

        const conflicts = this._registry?.conflicts(accel, this._entry) ?? [];
        if (conflicts.length > 0) {
            this._pending = accel;
            this._conflictLabel.label = `Already used by: ${conflicts.map(c => c.label).join(', ')}`;
            this._conflictLabel.visible = true;
            this._buttons.visible = true;
            return Gdk.EVENT_STOP;
        }
        this._choose(accel);
        return Gdk.EVENT_STOP;
    }

    _choose(accel) {
        this.emit('chosen', accel ?? '');
        this.close();
    }
});

// ---------------------------------------------------------------------------
// Row

// params: {settings, key, isArray, title, subtitle, registry, label}
export function makeShortcutRow(params) {
    const {settings, key, isArray, title, subtitle, registry} = params;
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});

    const entry = registry?.add({
        label: params.label ?? title,
        settings, key, isArray,
    });

    const shortcutLabel = new Gtk.ShortcutLabel({
        disabled_text: 'Disabled',
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(shortcutLabel);

    const clear = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Clear shortcut',
    });
    clear.connect('clicked', () => writeAccelerator(settings, key, isArray, ''));
    row.add_suffix(clear);

    const update = () => {
        const accel = readAccelerator(settings, key, isArray);
        shortcutLabel.accelerator = accel;
        clear.visible = !!accel;
    };
    settings.connect(`changed::${key}`, update);
    update();

    row.connect('activated', () => {
        const dialog = new ShortcutDialog(row.get_root(), title, registry, entry);
        dialog.connect('chosen', (_d, accel) => writeAccelerator(settings, key, isArray, accel));
        dialog.present();
    });
    return row;
}

// ---------------------------------------------------------------------------
// Discovery

const WM_KEYS = [
    ['toggle-above', 'Toggle always on top', 'GNOME\'s built-in window shortcut'],
    ['toggle-on-all-workspaces', 'Toggle always on visible workspace', 'GNOME\'s built-in window shortcut'],
    ['always-on-top', 'Make window always on top', 'GNOME\'s built-in window shortcut (non-toggling)'],
];

export function gnomeShortcuts() {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup('org.gnome.desktop.wm.keybindings', true);
    if (!schema)
        return [];
    const settings = new Gio.Settings({settings_schema: schema});
    return WM_KEYS
        .filter(([key]) => schema.has_key(key))
        .map(([key, title, subtitle]) => ({
            settings, key, isArray: true, title, subtitle,
            label: `GNOME: ${title}`,
        }));
}

export function customShortcuts() {
    const source = Gio.SettingsSchemaSource.get_default();
    const listSchema = source?.lookup('org.gnome.settings-daemon.plugins.media-keys', true);
    const itemSchema = source?.lookup('org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', true);
    if (!listSchema || !itemSchema)
        return [];

    const list = new Gio.Settings({settings_schema: listSchema});
    const result = [];
    for (const path of list.get_strv('custom-keybindings')) {
        let settings;
        try {
            settings = new Gio.Settings({settings_schema: itemSchema, path});
        } catch {
            continue;
        }
        const name = settings.get_string('name');
        const command = settings.get_string('command');
        if (!COMMAND_RE.test(`${name} ${command}`))
            continue;
        result.push({
            settings, key: 'binding', isArray: false,
            title: name || command,
            subtitle: command,
            label: `Custom shortcut: ${name || command}`,
        });
    }
    return result;
}

function extensionDirs() {
    const dirs = [];
    const userDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions']);
    dirs.push(userDir);
    for (const dataDir of GLib.get_system_data_dirs())
        dirs.push(GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions']));
    return dirs;
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

function enabledExtensions() {
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        return new Set(settings.get_strv('enabled-extensions'));
    } catch {
        return new Set();
    }
}

// Shortcuts in other extensions' schemas whose key name looks related.
export function extensionShortcuts(ownUuid) {
    const enabled = enabledExtensions();
    const parentSource = Gio.SettingsSchemaSource.get_default();
    const result = [];
    const seen = new Set();

    for (const base of extensionDirs()) {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(base).enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const uuid = info.get_name();
            if (uuid === ownUuid || seen.has(uuid))
                continue;
            const extDir = GLib.build_filenamev([base, uuid]);
            const schemasDir = GLib.build_filenamev([extDir, 'schemas']);
            if (!GLib.file_test(schemasDir, GLib.FileTest.IS_DIR))
                continue;

            const metadata = readText(GLib.build_filenamev([extDir, 'metadata.json']));
            let extName = uuid;
            try {
                extName = JSON.parse(metadata ?? '{}').name ?? uuid;
            } catch {
                // keep uuid
            }

            let schemaEnumerator;
            try {
                schemaEnumerator = Gio.File.new_for_path(schemasDir).enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            } catch {
                continue;
            }
            let schemaSource = null;
            let schemaInfo;
            while ((schemaInfo = schemaEnumerator.next_file(null)) !== null) {
                const file = schemaInfo.get_name();
                if (!file.endsWith('.gschema.xml'))
                    continue;
                const xml = readText(GLib.build_filenamev([schemasDir, file]));
                if (!xml)
                    continue;

                const schemaRe = /<schema\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/schema>/g;
                let schemaMatch;
                while ((schemaMatch = schemaRe.exec(xml)) !== null) {
                    const [, schemaId, body] = schemaMatch;
                    if (!/path="/.test(schemaMatch[0]))
                        continue; // relocatable, cannot open without a path
                    const keyRe = /<key\s+name="([^"]+)"\s+type="as"[^>]*>([\s\S]*?)<\/key>/g;
                    let keyMatch;
                    while ((keyMatch = keyRe.exec(body)) !== null) {
                        const [, keyName, keyBody] = keyMatch;
                        if (!KEYBINDING_NAME_RE.test(keyName))
                            continue;
                        if (!schemaSource) {
                            try {
                                schemaSource = Gio.SettingsSchemaSource.new_from_directory(
                                    schemasDir, parentSource, false);
                            } catch {
                                break;
                            }
                        }
                        const schema = schemaSource.lookup(schemaId, false);
                        if (!schema || !schema.has_key(keyName))
                            continue;
                        const summary = /<summary>([^<]*)<\/summary>/.exec(keyBody)?.[1]?.trim();
                        seen.add(uuid);
                        result.push({
                            settings: new Gio.Settings({settings_schema: schema}),
                            key: keyName,
                            isArray: true,
                            title: summary || keyName,
                            subtitle: `${extName}${enabled.has(uuid) ? '' : ' (not enabled)'}`,
                            label: `${extName}: ${summary || keyName}`,
                        });
                    }
                }
            }
        }
    }
    return result;
}
