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
    readme)
        # Showcase settings for README screenshots
        gsettings set $SCHEMA badge-style pill
        gsettings set $SCHEMA outline-glow true
        gsettings set $SCHEMA outline-width 3
        gsettings set $SCHEMA state-change-feedback none ;;
    dodge)
        gsettings set $SCHEMA badge-size 28
        gsettings set $SCHEMA badge-dodge true
        gsettings set $SCHEMA badge-hover-fade true
        gsettings set $SCHEMA badge-click-through true
        gsettings set $SCHEMA badge-dodge-distance 90
        gsettings set $SCHEMA state-change-feedback none ;;
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
[ -n "${DISPLAY:-}" ] && xterm -T Terminal -geometry 60x20+700+300 -e bash --norc --noprofile > "$OUT/xterm.log" 2>&1 &
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
if [ "$SCENARIO" = dodge ]; then
    # Move a virtual pointer toward the calculator badge and watch it dodge.
    # badgeinfo → [stage x, stage y, translation x, translation y, tilt, opacity, reactive]
    badgeinfo() {
        ev "(() => { const ext = Main.extensionManager.lookup('$UUID').stateObj; const i = [...ext._overlays._indicators.values()].find(i => (i.window.get_wm_class() ?? '').toLowerCase().includes('calc')); const b = i._badge; const [sx, sy] = i._container.get_transformed_position(); return [Math.round(sx + b.x + b.width / 2), Math.round(sy + b.y + b.height / 2), Math.round(b.translation_x), Math.round(b.translation_y), Math.round(b.rotation_angle_z), b.opacity, b.reactive, ext._overlays.pointerTracking]; })()"
    }
    pointer() {
        ev "(() => { const seat = Clutter.get_default_backend().get_default_seat(); globalThis.__vp ??= seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE); globalThis.__vp.notify_absolute_motion(global.get_current_time() * 1000, $1, $2); return global.get_pointer().slice(0, 2); })()"
    }
    echo "--- dodge: rest"; REST=$(badgeinfo); echo "$REST"
    BX=$(echo "$REST" | python3 -c 'import sys,json; print(json.load(sys.stdin)[0])')
    BY=$(echo "$REST" | python3 -c 'import sys,json; print(json.load(sys.stdin)[1])')
    echo "pointer far: $(pointer 100 850)"; sleep 0.5
    echo "far: $(badgeinfo)"
    echo "pointer near (40px left of badge): $(pointer $((BX - 40)) $((BY + 10)))"; sleep 0.8
    shot 10-dodge-near
    echo "near: $(badgeinfo)"
    echo "pointer on rest spot: $(pointer $BX $BY)"; sleep 0.8
    shot 11-dodge-on-rest
    echo "on rest: $(badgeinfo)"
    echo "pointer chasing (below): $(pointer $BX $((BY + 60)))"; sleep 0.8
    shot 12-dodge-chase
    echo "chase: $(badgeinfo)"
    echo "pointer far again: $(pointer 100 850)"; sleep 1.2
    shot 13-dodge-returned
    echo "returned: $(badgeinfo)"
    # hover fade: park the pointer on the (returned) badge
    echo "pointer on badge: $(pointer $BX $BY)"; sleep 0.8
    echo "faded (dodge pushes it away first, so opacity should be full): $(badgeinfo)"
    gsettings set $SCHEMA badge-dodge false; sleep 0.5
    echo "dodge off, pointer still on badge: $(pointer $((BX + 1)) $BY)"; sleep 0.8
    shot 14-hover-fade
    echo "faded: $(badgeinfo)"
    echo "pointer away: $(pointer 100 850)"; sleep 0.8
    echo "unfaded: $(badgeinfo)"
    gsettings set $SCHEMA badge-click-through false; sleep 0.3
    echo "click-through off: $(badgeinfo)"
    gsettings set $SCHEMA badge-hover-fade false; sleep 0.3
    echo "tracking off: $(badgeinfo)"
fi
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
