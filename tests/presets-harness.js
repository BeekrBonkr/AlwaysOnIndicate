// Checks the preset system without a nested shell: builds the preferences
// window (never presents it), finds the preset button in the header bar, and
// applies every preset to verify it round-trips and leaves the protected
// keys alone.
// Usage: gjs -m tests/presets-harness.js <extension dir>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();

const [extPath] = ARGV;
const dir = Gio.File.new_for_path(extPath);
const [, metaBytes] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metaBytes));

Adw.init();
const loop = new GLib.MainLoop(null, false);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

let failures = 0;
function check(ok, what) {
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok)
        failures++;
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

async function run() {
    const presets = await import(dir.get_child('presets.js').get_uri());
    const prefsModule = await import(dir.get_child('prefs.js').get_uri());
    const prefsObj = new prefsModule.default({...metadata, dir, path: extPath});
    const dialog = new Adw.PreferencesWindow({title: metadata.name});
    await prefsObj.fillPreferencesWindow(dialog);
    const settings = dialog._settings;

    // --- the button lives in the header bar ---------------------------------
    const header = find(dialog, w => w instanceof Adw.HeaderBar);
    check(!!header, 'header bar found');
    const button = find(header ?? dialog, w => w instanceof Gtk.MenuButton &&
        w.tooltip_text === 'Choose a preset');
    check(!!button, 'preset button is in the header bar');
    const pages = [...walk(dialog)].filter(w => w instanceof Adw.PreferencesPage);
    print(`pages: ${pages.map(p => p.title).join(', ')}`);
    check(pages.some(p => p.title === 'About'), 'About page present');
    check(!find(pages.find(p => p.title === 'General'), w => w instanceof Adw.ActionRow &&
        w.title === 'Preset'), 'no fallback preset row on General while the header bar works');

    // --- every preset round-trips ------------------------------------------
    const protectedProbe = {
        'kb-toggle-both': new GLib.Variant('as', ['<Super>p']),
        'app-rules': new GLib.Variant('s', '[{"match":"firefox"}]'),
        'indicate-sticky': new GLib.Variant('b', false),
        'deco-csd-radius-top': new GLib.Variant('i', 20),
        'saved-states': new GLib.Variant('s', '[{"x":1}]'),
    };
    for (const [key, value] of Object.entries(protectedProbe))
        settings.set_value(key, value);

    const before = presets.snapshot(settings);
    for (const preset of presets.PRESETS) {
        presets.applyPreset(settings, preset);
        // The button's label is refreshed on a debounce; let it run.
        await sleep(180);
        check(presets.matchesPreset(settings, preset), `${preset.id}: matches after apply`);
        const status = presets.presetStatus(settings);
        check(status.preset?.id === preset.id && !status.modified,
            `${preset.id}: reported as active and unmodified`);
        check(button?.label === preset.name, `${preset.id}: button reads "${button?.label}"`);
        const kept = Object.entries(protectedProbe)
            .every(([key, value]) => settings.get_value(key).equal(value));
        check(kept, `${preset.id}: shortcuts, rules, states and profiles untouched`);
        // Every value the preset asks for actually landed.
        const wrote = Object.entries(preset.values).every(([key, value]) => {
            const got = settings.get_value(key);
            return got.deepUnpack() === value;
        });
        check(wrote, `${preset.id}: all ${Object.keys(preset.values).length} values written`);
    }

    // --- applying is order-independent --------------------------------------
    const neon = presets.presetById('neon');
    const minimal = presets.presetById('minimal');
    presets.applyPreset(settings, neon);
    presets.applyPreset(settings, minimal);
    check(presets.matchesPreset(settings, minimal) && !settings.get_boolean('outline-glow'),
        'minimal after neon leaves no glow behind');

    // --- a tweak marks the preset modified ----------------------------------
    settings.set_int('badge-size', 41);
    await sleep(180);
    check(button?.label === 'Minimal (modified)', `button reads "${button?.label}"`);
    const tweaked = presets.presetStatus(settings);
    check(tweaked.preset?.id === 'minimal' && tweaked.modified,
        'editing a covered key reports "Minimal (modified)"');

    // --- undo restores the exact snapshot -----------------------------------
    presets.restore(settings, before);
    const restored = presets.managedKeys(settings)
        .every(key => settings.get_value(key).equal(before.get(key)));
    check(restored, 'undo restores every managed key');

    for (const key of Object.keys(protectedProbe))
        settings.reset(key);
    settings.reset('active-preset');

    dialog.close();
    print(failures ? `\n${failures} FAILURES` : '\nall preset checks passed');
    loop.quit();
}

run().catch(e => {
    print(`HARNESS ERROR: ${e}\n${e.stack}`);
    failures++;
    loop.quit();
});
loop.run();
if (failures)
    imports.system.exit(1);
