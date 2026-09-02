import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
const IFACE = `<node><interface name="local.AoiTestHelper">
<method name="Screenshot"><arg type="s" direction="in" name="path"/><arg type="b" direction="out" name="ok"/></method>
<method name="Eval"><arg type="s" direction="in" name="code"/><arg type="s" direction="out" name="result"/></method>
</interface></node>`;
export default class Helper extends Extension {
    enable() {
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._impl.export(Gio.DBus.session, '/local/AoiTestHelper');
        globalThis.__Main = Main;
    }
    disable() { this._impl.unexport(); this._impl = null; }
    async ScreenshotAsync([path], invocation) {
        try {
            const shooter = new Shell.Screenshot();
            const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
            await shooter.screenshot(false, stream);
            stream.close(null);
            invocation.return_value(new GLib.Variant('(b)', [true]));
        } catch (e) {
            invocation.return_dbus_error('local.AoiTestHelper.Error', String(e));
        }
    }
    Eval(code) {
        try {
            const Main = globalThis.__Main;
            const r = eval(code);
            return r === undefined ? 'undefined' : (typeof r === 'object' ? JSON.stringify(r) : String(r));
        } catch (e) { return `ERR ${e}\n${e.stack ?? ''}`; }
    }
}
