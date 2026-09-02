#!/bin/bash
# Runs inside dbus-run-session. Env: OUT, UUID, SCENARIO, S
set -u
DB="--dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/AlwaysOnIndicate"
IF=org.gnome.Shell.Extensions.AlwaysOnIndicate
SCHEMA=org.gnome.shell.extensions.always-on-indicate
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
export GSETTINGS_SCHEMA_DIR="$EXT/schemas"

shot() {
    gdbus call --session --dest org.gnome.Shell --object-path /local/AoiTestHelper \
        --method local.AoiTestHelper.Screenshot "$OUT/$1.png" 2>&1 | grep -v "^(true" | sed "s/^/screenshot $1: /"
}
ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /local/AoiTestHelper \
        --method local.AoiTestHelper.Eval "$1" | python3 -c 'import sys,ast; print(ast.literal_eval(sys.stdin.read().strip())[0])'
}
call() { gdbus call --session $DB --method $IF.$1 "${@:2}"; }
winid() {
    call ListWindows | python3 -c "
import sys,json,ast
d=json.loads(ast.literal_eval(sys.stdin.read().strip())[0])
print(next((w['id'] for w in d if '$1'.lower() in (w['wm_class']+' '+w['app_id']).lower()),0))"
}
overlays() {
    ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; return [...ext._overlays._indicators.values()].map(i => ({title: i.window.title, layer: i._layer, shown: i._shown, profile: i._geometry?.profile, radius: [i._geometry?.radiusTop, i._geometry?.radiusBottom], pos: [i._container.x, i._container.y, i._container.width, i._container.height], badge: [i._badge.x, i._badge.y, i._badge.width, i._badge.height, i._badge.visible], outline: [i._outline.x, i._outline.y, i._outline.width, i._outline.height], parent: i._container.get_parent()?.constructor?.name})); })()"
}

gsettings set org.gnome.shell enabled-extensions "['$UUID', 'aoi-test-helper@local']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999.0'
case "$SCENARIO" in
    stage)
        gsettings set $SCHEMA overlay-layer stage ;;
    pill)
        gsettings set $SCHEMA badge-style pill
        gsettings set $SCHEMA outline-position outside
        gsettings set $SCHEMA outline-glow true
        gsettings set $SCHEMA outline-width 3
        gsettings set $SCHEMA badge-corner bottom-right ;;
    opacity)
        gsettings set $SCHEMA above-unfocused-opacity 60
        gsettings set $SCHEMA indicator-visibility focused ;;
esac

gnome-shell ${SHELL_MODE:---headless} --wayland --virtual-monitor 1600x900 > "$OUT/shell.log" 2>&1 &
SHELL_PID=$!
for i in $(seq 1 40); do
    grep -q "Using Wayland display name" "$OUT/shell.log" 2>/dev/null && break
    sleep 0.5
done
sleep 4
WD=$(grep -o "Using Wayland display name .wayland-[0-9]*" "$OUT/shell.log" | grep -o "wayland-[0-9]*" | head -1)
if [ -z "$WD" ]; then echo "no nested wayland display, aborting"; kill $SHELL_PID; exit 1; fi
export WAYLAND_DISPLAY=$WD
export DISPLAY=$(grep -o "Using public X11 display :[0-9]*" "$OUT/shell.log" | grep -o ":[0-9]*" | head -1)
export XAUTHORITY=$(ls -t /run/user/$(id -u)/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
echo "nested wayland: $WD  x11: ${DISPLAY:-none} xauth: ${XAUTHORITY:-none}"
ev "Main.overview.hide(); 1" >/dev/null

gnome-calculator >/dev/null 2>&1 &
sleep 3
[ -n "${DISPLAY:-}" ] && xterm -geometry 60x20+700+300 > "$OUT/xterm.log" 2>&1 &
gedit >/dev/null 2>&1 &
sleep 5
shot 01-before
echo "--- ListWindows"; call ListWindows | cut -c1-2500; echo
CALC=$(winid calculator); GEDIT=$(winid gedit); XTERM=$(winid xterm)
echo "ids calc=$CALC gedit=$GEDIT xterm=$XTERM"
call SetState "$CALC" true false >/dev/null
call SetState "$GEDIT" false true >/dev/null
[ "$XTERM" != 0 ] && call SetState "$XTERM" true true >/dev/null
sleep 1.5
shot 02-pinned
echo "--- overlays after pin"; overlays
echo "--- window actor opacity"; ev "global.get_window_actors().map(a => [a.meta_window.title, a.opacity, a.meta_window.has_focus()])"
echo "--- panel"; ev "(() => { const b = Main.panel.statusArea['always-on-indicate']; return {visible: b.visible, count: b._count.text, icon: b._icon.icon_name, style: b._icon.get_style()}; })()"
call ToggleAbove "$CALC" >/dev/null
sleep 1
shot 03-calc-unpinned
echo "--- overlays after unpin calc"; overlays
call TogglePin "$CALC" >/dev/null
sleep 1
echo "--- panel menu"; ev "Main.panel.statusArea['always-on-indicate'].menu.open(); 1" >/dev/null
sleep 1.5
shot 04-panel-menu
ev "(() => { const m = Main.panel.statusArea['always-on-indicate'].menu; return m._getMenuItems().map(i => i.label?.text ?? i.constructor.name); })()"
ev "Main.panel.statusArea['always-on-indicate'].menu.close(); 1" >/dev/null
sleep 0.5
# badge menu
echo "--- badge click"; ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; const ind = [...ext._overlays._indicators.values()][0]; ind._badge.emit('clicked', 1); return ind.window.title; })()"
sleep 1
shot 05-badge-menu
ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; return ext._overlays._menu ? ext._overlays._menu._getMenuItems().map(i => i.label?.text ?? i.constructor.name) : 'no menu'; })()"
ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; ext._overlays._menu?.close(); return 1; })()" >/dev/null
sleep 0.5
ev "Main.overview.show(); 1" >/dev/null
sleep 2
shot 06-overview
echo "--- dock badges"; ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; return [...ext._dock._badges.entries()].map(([icon, b]) => ({app: icon.app.get_id(), visible: b.visible})); })()"
ev "Main.overview.hide(); 1" >/dev/null
sleep 1.5
# maximize gedit → radius should drop to 0
ev "(() => { const w = global.get_window_actors().map(a => a.meta_window).find(w => (w.get_wm_class() ?? '').toLowerCase().includes('gedit')); w.maximize(3); return 1; })()" >/dev/null
sleep 1.5
shot 07-maximized
echo "--- overlays maximized"; overlays
call ToggleIndicators >/dev/null
sleep 1
shot 08-hidden
call ToggleIndicators >/dev/null
call UnpinAll >/dev/null
sleep 1
shot 09-unpinned
echo "--- overlays after unpin all"; overlays
# preferences window
echo "--- prefs"; GI_TYPELIB_PATH=/usr/lib64/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib64/gnome-shell GTK_USE_PORTAL=0 ADW_DISABLE_PORTAL=1 timeout 90 gjs -m "$S/prefs-harness.js" "$EXT" "$OUT" > "$OUT/prefs.log" 2>&1; echo "prefs exit $?"; grep -v "^$" "$OUT/prefs.log" | head -40
# disable/enable cycle
echo "--- disable/enable"; ev "Main.extensionManager.disableExtension('$UUID'); 1" >/dev/null
sleep 1.5
ev "Main.extensionManager.lookup('$UUID').state"
ev "Main.extensionManager.enableExtension('$UUID'); 1" >/dev/null
sleep 1.5
ev "Main.extensionManager.lookup('$UUID').state"
call SetState "$GEDIT" true true >/dev/null
sleep 1
overlays
echo "--- shell log (extension related)"
grep -n "JS ERROR\|always-on-indicate\|aoi\|CRITICAL" "$OUT/shell.log" | grep -v "Extension always-on-indicate.*already\|already installed" | head -40
kill $SHELL_PID 2>/dev/null
sleep 1
kill $(jobs -p) 2>/dev/null
