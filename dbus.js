// SPDX-License-Identifier: GPL-3.0-or-later
//
// A small D-Bus interface so that the preferences dialog (a separate
// process) can list open windows for the app-rule picker, and so that
// scripts and custom keyboard shortcuts can drive the extension:
//
//   gdbus call --session --dest org.gnome.Shell \
//       --object-path /org/gnome/Shell/Extensions/AlwaysOnIndicate \
//       --method org.gnome.Shell.Extensions.AlwaysOnIndicate.ToggleAbove 0
//
// Window ids are mutter's stable ids (Meta.Window.get_id()); 0 means the
// focused window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {detectProfile} from './decorations.js';
import {rawState, windowAppId} from './util.js';

export const DBUS_NAME = 'org.gnome.Shell';
export const DBUS_PATH = '/org/gnome/Shell/Extensions/AlwaysOnIndicate';
export const DBUS_IFACE = 'org.gnome.Shell.Extensions.AlwaysOnIndicate';

const IFACE_XML = `
<node>
  <interface name="${DBUS_IFACE}">
    <method name="ListWindows">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="ToggleAbove">
      <arg type="t" direction="in" name="id"/>
    </method>
    <method name="ToggleSticky">
      <arg type="t" direction="in" name="id"/>
    </method>
    <method name="TogglePin">
      <arg type="t" direction="in" name="id"/>
    </method>
    <method name="SetState">
      <arg type="t" direction="in" name="id"/>
      <arg type="b" direction="in" name="above"/>
      <arg type="b" direction="in" name="sticky"/>
    </method>
    <method name="UnpinAll"/>
    <method name="CyclePinned"/>
    <method name="ToggleIndicators"/>
    <signal name="StateChanged">
      <arg type="t" name="id"/>
      <arg type="b" name="above"/>
      <arg type="b" name="sticky"/>
    </signal>
  </interface>
</node>`;

export class DBusService {
    // callbacks: {toggleIndicators}
    constructor(tracker, actions, callbacks) {
        this._tracker = tracker;
        this._actions = actions;
        this._callbacks = callbacks;

        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._impl.export(Gio.DBus.session, DBUS_PATH);

        this._tracker.connectObject('state-changed', (_t, window, state) => {
            this._impl.emit_signal('StateChanged', new GLib.Variant('(tbb)',
                [window.get_id(), state.above, state.sticky]));
        }, this);
    }

    destroy() {
        this._tracker.disconnectObject(this);
        this._impl.unexport();
        this._impl = null;
        this._tracker = null;
        this._actions = null;
    }

    _window(id) {
        if (!id || Number(id) === 0)
            return this._tracker.focusedWindow;
        return this._tracker.windows.find(w => w.get_id() === Number(id)) ?? null;
    }

    ListWindows() {
        const focus = global.display.focus_window;
        const list = this._tracker.windows.map(window => {
            const {above, sticky} = rawState(window);
            const frame = window.get_frame_rect();
            return {
                id: window.get_id(),
                title: window.get_title() ?? '',
                wm_class: window.get_wm_class() ?? '',
                wm_class_instance: window.get_wm_class_instance() ?? '',
                app_id: windowAppId(window),
                above, sticky,
                focused: window === focus,
                workspace: window.get_workspace()?.index() ?? -1,
                monitor: window.get_monitor(),
                profile: detectProfile(window),
                decorated: window.decorated,
                client: window.get_client_type() === 1 ? 'x11' : 'wayland',
                frame: {x: frame.x, y: frame.y, width: frame.width, height: frame.height},
            };
        });
        return JSON.stringify(list);
    }

    ToggleAbove(id) {
        const window = this._window(id);
        if (window)
            this._actions.toggleAbove(window);
    }

    ToggleSticky(id) {
        const window = this._window(id);
        if (window)
            this._actions.toggleSticky(window);
    }

    TogglePin(id) {
        const window = this._window(id);
        if (window)
            this._actions.toggleBoth(window);
    }

    SetState(id, above, sticky) {
        const window = this._window(id);
        if (window)
            this._actions.setState(window, {above, sticky});
    }

    UnpinAll() {
        this._actions.unpinAll();
    }

    CyclePinned() {
        this._actions.cyclePinned();
    }

    ToggleIndicators() {
        this._callbacks.toggleIndicators?.();
    }
}
