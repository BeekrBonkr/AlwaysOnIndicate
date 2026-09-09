// Opens the extension's preferences window the way gnome-extensions-app
// does, walks through every page, exercises a few dialogs and takes
// screenshots through the test helper extension running in the nested shell.
// Usage: gjs -m prefs-harness.js <extension dir> <out dir>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();

const [extPath, outDir] = ARGV;
const dir = Gio.File.new_for_path(extPath);
const [, metaBytes] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metaBytes));
const extension = {uuid: metadata.uuid, metadata, dir, path: extPath};

Adw.init();
const loop = new GLib.MainLoop(null, false);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function shot(name) {
    try {
        Gio.DBus.session.call_sync('org.gnome.Shell', '/local/AoiTestHelper', 'local.AoiTestHelper',
            'Screenshot', new GLib.Variant('(s)', [`${outDir}/${name}.png`]), null,
            Gio.DBusCallFlags.NONE, 5000, null);
    } catch (e) {
        print(`screenshot ${name} failed: ${e.message}`);
    }
}

function* walk(widget) {
    yield widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* walk(child);
}

function find(root, predicate) {
    for (const w of walk(root)) {
        if (predicate(w))
            return w;
    }
    return null;
}

function findAll(root, predicate) {
    return [...walk(root)].filter(predicate);
}

async function run() {
    print('importing prefs.js');
    const prefsModule = await import(dir.get_child('prefs.js').get_uri());
    print('imported');
    const prefsObj = new prefsModule.default({...metadata, dir, path: extPath});
    const dialog = new Adw.PreferencesWindow({title: metadata.name});
    print('filling window');
    await prefsObj.fillPreferencesWindow(dialog);
    print('filled');
    dialog.set_default_size(760, 720);
    dialog.present();
    await sleep(1500);

    const pages = [];
    for (const w of walk(dialog)) {
        if (w instanceof Adw.PreferencesPage)
            pages.push(w);
    }
    print(`pages: ${pages.map(p => p.title).join(', ')}`);
    for (const page of pages) {
        dialog.set_visible_page(page);
        await sleep(700);
        shot(`prefs-${page.title.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    }

    // Preset popover in the header bar
    const presetButton = find(dialog, w => w instanceof Gtk.MenuButton &&
        w.tooltip_text === 'Choose a preset');
    print(`preset button: ${presetButton ? `"${presetButton.label}"` : 'none'}`);
    if (presetButton) {
        presetButton.popover.popup();
        await sleep(800);
        shot('prefs-presets');
        const list = find(presetButton.popover, w => w instanceof Gtk.ListBox);
        const names = list ? [...walk(list)].filter(w => w instanceof Gtk.ListBoxRow)
            .map(r => r._preset.name) : [];
        print(`presets: ${names.join(', ')}`);
        presetButton.popover.popdown();
        await sleep(300);
    }

    // General page: open the icon picker and search it
    const generalPage = pages.find(p => p.title === 'General');
    dialog.set_visible_page(generalPage);
    await sleep(300);
    const browse = find(generalPage, w => w instanceof Gtk.Button &&
        w.tooltip_text === 'Browse the icons installed on this system');
    print(`icon browse button: ${!!browse}`);
    browse?.emit('clicked');
    await sleep(1200);
    shot('prefs-icon-picker');
    const iconDialog = find(dialog, w => w instanceof Adw.Dialog);
    const iconSearch = iconDialog ? find(iconDialog, w => w instanceof Gtk.SearchEntry) : null;
    const iconGrid = iconDialog ? find(iconDialog, w => w instanceof Gtk.GridView) : null;
    print(`icon picker: dialog ${!!iconDialog}, search ${!!iconSearch}, grid items ${iconGrid?.model.get_n_items() ?? '-'}`);
    if (iconSearch) {
        iconSearch.text = 'pin';
        await sleep(600);
        print(`after search "pin": ${iconGrid?.model.get_n_items()} items`);
        shot('prefs-icon-picker-search');
        iconSearch.emit('activate');
        await sleep(400);
        print(`icon-above now: ${dialog._settings?.get_string('icon-above')}`);
        dialog._settings?.reset('icon-above');
    }
    if (iconDialog?.get_mapped?.())
        iconDialog.close();
    await sleep(300);

    // Shortcuts page: open the capture dialog on the first extension shortcut row
    const shortcutsPage = pages.find(p => p.title === 'Shortcuts');
    dialog.set_visible_page(shortcutsPage);
    await sleep(300);
    const rows = findAll(shortcutsPage, w => w instanceof Adw.ActionRow && w.activatable);
    print(`shortcut rows: ${rows.length}: ${rows.slice(0, 12).map(r => `${r.title} [${find(r, w => w instanceof Gtk.ShortcutLabel)?.accelerator || '-'}]`).join(' | ')}`);
    const row = rows.find(r => r.title === 'Pin / unpin');
    row?.activate();
    await sleep(800);
    shot('prefs-shortcut-dialog');
    // Close the capture dialog (Escape)
    const capture = Gtk.Window.list_toplevels().find(w => w !== dialog && w.visible && w.modal);
    print(`capture dialog: ${capture?.title ?? 'none'}`);
    capture?.close();
    await sleep(300);

    // Windows page: use the window picker
    const windowsPage = pages.find(p => p.title === 'Windows');
    dialog.set_visible_page(windowsPage);
    await sleep(300);
    const pick = find(windowsPage, w => w instanceof Gtk.Button && w.label === 'Add From Open Window…');
    print(`picker button: ${!!pick}`);
    pick?.emit('clicked');
    await sleep(1500);
    shot('prefs-window-picker');
    const pickerDialog = find(dialog, w => w instanceof Adw.Dialog);
    const pickRow = pickerDialog ? find(pickerDialog, w => w instanceof Adw.ActionRow && w.activatable) : null;
    print(`picker rows: ${pickerDialog ? findAll(pickerDialog, w => w instanceof Adw.ActionRow).map(r => r.title).join(' | ') : 'no dialog'}`);
    pickRow?.activate();
    await sleep(800);
    // Expand the new rule and toggle auto-above
    const expander = find(windowsPage, w => w instanceof Adw.ExpanderRow && w.title !== '' &&
        !['Server-side decorations', 'Client-side decorations', 'X11 with server-side decorations',
            'X11 with client-side decorations', 'Undecorated'].includes(w.title));
    print(`rule row: ${expander?.title ?? 'none'} / ${expander?.subtitle ?? ''}`);
    if (expander) {
        expander.expanded = true;
        await sleep(300);
        const autoAbove = find(expander, w => w instanceof Adw.SwitchRow && w.title === 'Always on top when opened');
        if (autoAbove)
            autoAbove.active = true;
        await sleep(300);
        // scroll the page so the rule is visible
        const scrolled = find(windowsPage, w => w instanceof Gtk.ScrolledWindow);
        if (scrolled)
            scrolled.vadjustment.value = scrolled.vadjustment.upper;
        await sleep(500);
        shot('prefs-rule-expanded');
        print(`rule subtitle now: ${expander.subtitle}`);
    }
    const settings = dialog._settings;
    print(`app-rules setting: ${settings?.get_string('app-rules')}`);

    // Change a couple of settings to make sure bindings write through
    const outlinePage = pages.find(p => p.title === 'Outline');
    dialog.set_visible_page(outlinePage);
    const widthRow = find(outlinePage, w => w instanceof Adw.SpinRow && w.title === 'Width');
    if (widthRow)
        widthRow.value = 4;
    await sleep(300);
    print(`outline-width now: ${settings?.get_int('outline-width')}`);

    dialog.close();
    await sleep(300);
    loop.quit();
}

run().catch(e => {
    print(`HARNESS ERROR: ${e}\n${e.stack}`);
    loop.quit();
});
loop.run();
