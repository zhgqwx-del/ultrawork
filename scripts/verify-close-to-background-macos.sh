#!/bin/zsh
# macOS real-device gate for close-to-background (ADR-074 / discussions/061).
#
# Drives the NATIVE window through the Accessibility API (System Events) —
# Playwright cannot reach the close button, the Dock, or the menu-bar status
# item — and asserts on process/port/AX facts, never on screenshots.
#
# Steps (each prints PASS/FAIL; exit code = number of failures):
#   1  X hides: app + 4 sidecars alive, AX windows 1→0, no [shutdown]
#   2  Dock click restores (RunEvent::Reopen)
#   3  Cmd+W hides; menu-bar menu lists open/quit; "open" restores
#   4  minimize → Dock click un-minimizes
#   5  native fullscreen → Cmd+W leaves fullscreen (window stays); next Cmd+W hides
#   5b rapid double Cmd+W in fullscreen: second press refused, never a fullscreen hide
#   6  second launch → single-instance restores, still 1 instance
#   7  Cmd+Q → [shutdown] ×4, zero listeners, ports.json gone
#   8  boot failure (foreign listener on 4096) → X quits (control arm for step 1)
#
# Prereqs: an IDLE desktop for the whole run (AX clicks and CGEvents go to whatever
# is in front — another app being used invalidates every step from then on);
# Terminal/IDE has Accessibility permission (AX reads + CGEvent posting); nothing on 1420/4096-4099
# (the installed Ultrawork.app must be quit — it now stays resident after X).
# Keeps the display awake for the run: with the display asleep, AX reports
# 0 windows and keystrokes are not delivered (learned the hard way).
#
# Usage: scripts/verify-close-to-background-macos.sh   (from repo root, ~3 min)

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/packages/client/desktop"
LOG="${TMPDIR:-/tmp}/verify-close-to-background.$$.log"
FAIL=0
PASS=0

say()  { print -- "$@" }
ok()   { PASS=$((PASS+1)); say "  PASS  $1" }
bad()  { FAIL=$((FAIL+1)); say "  FAIL  $1" }
check(){ if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi }

app_pid()      { pgrep -f "target/debug/ultrawork" | head -1 }
win_count()    { osascript -e 'tell application "System Events" to tell process "ultrawork" to get count of windows' 2>/dev/null || echo -1 }
listeners()    { lsof -ti tcp:4096 -ti tcp:4097 -ti tcp:4098 -ti tcp:4099 -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ',' }
n_listeners()  { lsof -ti tcp:4096 -ti tcp:4097 -ti tcp:4098 -ti tcp:4099 -sTCP:LISTEN 2>/dev/null | sort -u | wc -l | tr -d ' ' }
# grep -c prints "0" AND exits 1 on no match — never `|| echo 0` it (double "0").
shutdown_lines(){ local n; n=$(grep -c "\[shutdown\] Killing" "$LOG" 2>/dev/null); print -- "${n:-0}" }
frontmost()    { osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null }
ax()           { osascript -e "tell application \"System Events\" to tell process \"ultrawork\" to $1" 2>/dev/null }
click_close()  { ax 'click (first button of window 1 whose subrole is "AXCloseButton")' >/dev/null }
dock_click_raw(){ osascript -e 'tell application "System Events" to tell process "Dock" to click UI element "ultrawork" of list 1' >/dev/null 2>&1 }
# The Dock is still sliding back in right after a fullscreen exit and an AX click
# can land on nothing. Retry once and SAY so — a needed retry is a ruler wobble
# worth seeing, a second miss is a real failure.
click_dock()   { dock_click_raw; sleep 2; [ "$(win_count)" = "1" ] && return 0; say "  (dock click missed once — retrying)"; dock_click_raw; sleep 2 }
# Real input (CGEvent) — see scripts/macos-hid.swift for why AX keystrokes/AXPress
# are not used for the fullscreen steps. Falls back to AX when swiftc is missing.
HID="${TMPDIR:-/tmp}/macos-hid.$$"
if command -v swiftc >/dev/null 2>&1; then
  swiftc -O "$ROOT/scripts/macos-hid.swift" -o "$HID" 2>/dev/null || HID=""
else
  HID=""
fi
# AX keystrokes are reliable for ordinary Cmd+W / Cmd+Q (100% over the earlier
# runs) and do not need the app to be exactly frontmost the instant the event is
# posted. Real CGEvents do — and right after a Space switch focus is unsettled —
# so they are used ONLY where AX itself corrupts AppKit state: entering
# fullscreen and the Cmd+W pressed while fullscreen.
keystroke()    { ax "set frontmost to true" >/dev/null; sleep 0.3; ax "keystroke \"$1\" using command down" >/dev/null }
fs_cmd_w()     { ax "set frontmost to true" >/dev/null; sleep 0.5
                 if [ -n "$HID" ]; then "$HID" key 13 cmd; else ax 'keystroke "w" using command down' >/dev/null; fi }
# A cursor parked over the traffic lights opens macOS's "Move & Resize" hover popover
# once the window is back from fullscreen, and that popover swallows Cmd+W / Cmd+Q —
# one whole run (and the next, since the window reopens under the same cursor) went
# red from exactly this. Park the cursor in the window body after every real click.
park_mouse()   { [ -n "$HID" ] && "$HID" move 700 500 >/dev/null 2>&1 || true }
# Real click on the green zoom button (AX only to find it, never to press it).
click_zoom()   { local P S X Y
                 P=$(ax 'get position of (first button of window 1 whose subrole is "AXFullScreenButton")')
                 S=$(ax 'get size of (first button of window 1 whose subrole is "AXFullScreenButton")')
                 if [ -n "$HID" ] && [ -n "$P" ]; then
                   X=$(( ${P%%,*} + ${S%%,*} / 2 )); Y=$(( ${P##*, } + ${S##*, } / 2 )); "$HID" click "$X" "$Y"
                   park_mouse
                 else ax 'click (first button of window 1 whose subrole is "AXFullScreenButton")' >/dev/null; fi }
wait_gone()    { local i; for i in $(seq 1 "${1:-15}"); do [ -z "$(app_pid)" ] && return 0; sleep 1; done; return 1 }
wait_boot()    { local i; for i in $(seq 1 100); do [ "$(n_listeners)" = "4" ] && { sleep 6; return 0; }; sleep 3; done; return 1 }

start_dev() {
  (cd "$DESKTOP" && bun run --bun tauri dev >"$LOG" 2>&1 &)
  sleep 1
}
stop_dev() {
  # tauri dev exits with the app; reap any vite leftovers by PORT, not by name.
  local p; for p in $(lsof -ti:1420 2>/dev/null); do kill "$p" 2>/dev/null; done
}
own_fullscreen_spaces() {
  # Count fullscreen Spaces owned by our pid in the WindowServer's space list.
  local pid="$1"
  defaults export com.apple.spaces - 2>/dev/null | plutil -convert json -o - - 2>/dev/null \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
n=0
for m in d['SpacesDisplayConfiguration']['Management Data']['Monitors']:
    for s in m.get('Spaces',[]):
        if s.get('type')==4 and s.get('pid')==$pid: n+=1
print(n)"
}

# ---------------------------------------------------------------- preflight
say "== preflight"
if [ -n "$(lsof -ti:1420 2>/dev/null)$(listeners)" ]; then
  say "  ABORT: something is listening on 1420 or 4096-4099 (installed Ultrawork.app still running?)"
  say "         it now stays resident after X — quit it via Cmd+Q / tray, then rerun."
  exit 99
fi
if [ -n "$(app_pid)" ]; then say "  ABORT: a target/debug/ultrawork is already running"; exit 99; fi
caffeinate -d -u -t 900 >/dev/null 2>&1 &
CAFF=$!
park_mouse
trap 'kill $CAFF 2>/dev/null; stop_dev; rm -f "$HID"' EXIT

# ---------------------------------------------------------------- boot
say "== boot (tauri dev)"
start_dev
if ! wait_boot; then say "  ABORT: sidecars did not come up (see $LOG)"; exit 98; fi
APP=$(app_pid); SIDECARS=$(listeners)
say "  app=$APP sidecars=$SIDECARS"
check "baseline: 1 window, 4 sidecars, no shutdown yet" '[ "$(win_count)" = "1" ] && [ "$(n_listeners)" = "4" ] && [ "$(shutdown_lines)" = "0" ]'
check "menu-bar status item present (menu bar 2)" '[ "$(ax "get description of menu bar item 1 of menu bar 2")" = "status menu" ]'

# ---------------------------------------------------------------- 1. X hides
say "== 1. close button"
click_close; sleep 2
check "X: process alive, same pid"            '[ "$(app_pid)" = "$APP" ]'
check "X: 4 sidecars unchanged"               '[ "$(listeners)" = "$SIDECARS" ]'
check "X: AX window count 1 -> 0"             '[ "$(win_count)" = "0" ]'
check "X: no [shutdown] in log"               '[ "$(shutdown_lines)" = "0" ]'
# With no window left the app must NOT stay the active app: the menu bar would keep
# saying "Ultrawork" over nothing, and the Dock bounce a finished turn asks for is
# a no-op for the active app (user acceptance #4).
check "X: app ceded activation (not frontmost)" '[ "$(frontmost)" != "ultrawork" ]'

# ---------------------------------------------------------------- 2. Dock
say "== 2. Dock click (Reopen)"
click_dock
check "Dock: window back"                     '[ "$(win_count)" = "1" ]'
check "Dock: app frontmost"                   '[ "$(frontmost)" = "ultrawork" ]'

# ---------------------------------------------------------------- 3. Cmd+W + tray
say "== 3. Cmd+W + menu-bar menu"
keystroke w; sleep 1.5
check "Cmd+W: hidden"                         '[ "$(win_count)" = "0" ]'
ITEMS=$(osascript -e 'tell application "System Events" to tell process "ultrawork"
  click menu bar item 1 of menu bar 2
  delay 0.5
  set names to name of every menu item of menu 1 of menu bar item 1 of menu bar 2
  click menu item 1 of menu 1 of menu bar item 1 of menu bar 2
  return names
end tell' 2>/dev/null)
say "  menu items: $ITEMS"
check "tray menu: 3 entries (open, separator, quit)" '[ "$(print -- "$ITEMS" | tr "," "\n" | wc -l | tr -d " ")" = "3" ]'
check "tray menu: labels are not raw i18n keys"      '! print -- "$ITEMS" | grep -q "tray\."'
sleep 1.5
check "tray 'open': window back"              '[ "$(win_count)" = "1" ]'

# ---------------------------------------------------------------- 4. minimize
say "== 4. minimize → Dock"
ax 'click (first button of window 1 whose subrole is "AXMinimizeButton")' >/dev/null; sleep 1.5
check "minimized (control: state really changed)" '[ "$(ax "get value of attribute \"AXMinimized\" of window 1")" = "true" ]'
click_dock
check "Dock un-minimizes"                     '[ "$(ax "get value of attribute \"AXMinimized\" of window 1")" = "false" ]'

# ---------------------------------------------------------------- 5. fullscreen
# Contract (ADR-074 D4, revised on-device): in native fullscreen the close button /
# Cmd+W only LEAVES fullscreen — the window stays; the next close hides. Hiding
# during the exit animation is not implementable reliably (see background.rs).
say "== 5. native fullscreen → Cmd+W leaves fullscreen, keeps the window"
sleep 1; click_zoom; sleep 5
check "fullscreen entered (control)"          '[ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "true" ]'
fs_cmd_w; sleep 3
say "  after Cmd+W: windows=$(win_count) fullscreen=$(ax 'get value of attribute "AXFullScreen" of window 1')"
check "fullscreen: window still visible"      '[ "$(win_count)" = "1" ]'
check "fullscreen: left fullscreen"           '[ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "false" ]'
check "fullscreen: no Space left behind"      '[ "$(own_fullscreen_spaces "$APP")" = "0" ]'
keystroke w; sleep 2
check "second Cmd+W after the exit: hidden"   '[ "$(win_count)" = "0" ]'
click_dock
say "  after Dock: windows=$(win_count) fullscreen=$(ax 'get value of attribute "AXFullScreen" of window 1')"
check "restored, not fullscreen"              '[ "$(win_count)" = "1" ] && [ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "false" ]'

# ---------------------------------------------------------------- 5b. rapid double Cmd+W
# The second press lands inside the exit animation. It must be REFUSED (window
# stays), never turned into a hide of a still-fullscreen window.
say "== 5b. fullscreen → Cmd+W, Cmd+W 300ms apart"
sleep 1; click_zoom; sleep 5
check "5b: fullscreen entered (control)"      '[ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "true" ]'
fs_cmd_w; sleep 0.3; fs_cmd_w; sleep 3
say "  after double Cmd+W: windows=$(win_count) fullscreen=$(ax 'get value of attribute "AXFullScreen" of window 1')"
check "5b: window still visible"              '[ "$(win_count)" = "1" ]'
check "5b: left fullscreen"                   '[ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "false" ]'
keystroke w; sleep 2
check "5b: a later Cmd+W hides"               '[ "$(win_count)" = "0" ]'
click_dock
check "5b: restored, not fullscreen"          '[ "$(win_count)" = "1" ] && [ "$(ax "get value of attribute \"AXFullScreen\" of window 1")" = "false" ]'

# ---------------------------------------------------------------- 6. single-instance
say "== 6. hide → second launch"
click_close; sleep 1.5
( "$DESKTOP/src-tauri/target/debug/ultrawork" >/dev/null 2>&1 & ); sleep 3
check "second launch: restored"               '[ "$(win_count)" = "1" ]'
check "second launch: still exactly 1 instance" '[ "$(pgrep -f target/debug/ultrawork | wc -l | tr -d " ")" = "1" ]'

# ---------------------------------------------------------------- 7. Cmd+Q
say "== 7. Cmd+Q"
keystroke q
check "Cmd+Q: process exits"                  'wait_gone 15'
sleep 2
check "Cmd+Q: [shutdown] killed 4 sidecars"   '[ "$(shutdown_lines)" = "4" ]'
check "Cmd+Q: zero listeners"                 '[ "$(n_listeners)" = "0" ]'
check "Cmd+Q: ports.json removed"             '[ ! -e "$HOME/.ultrawork/run/ports.json" ]'
stop_dev; sleep 1
check "Cmd+Q: no vite orphan on 1420"         '[ -z "$(lsof -ti:1420 2>/dev/null)" ]'

# ---------------------------------------------------------------- 8. boot failure
say "== 8. boot failure → X quits (control arm)"
python3 -m http.server 4096 --bind 127.0.0.1 >/dev/null 2>&1 &
SQUAT=$!
sleep 1
LOG="$LOG.boot-failure"   # keep the main run's log intact as evidence
start_dev
for i in $(seq 1 60); do grep -q "startup failed" "$LOG" 2>/dev/null && break; sleep 2; done
sleep 4
check "boot failed (control)"                 'grep -q "OpenCode Server startup failed" "$LOG"'
click_close
check "failed boot: X really quits"           'wait_gone 10'
kill $SQUAT 2>/dev/null
stop_dev; sleep 1
check "failed boot: remaining sidecars cleaned" '[ "$(n_listeners)" = "0" ]'

say ""
say "== result: $PASS passed, $FAIL failed  (log: $LOG)"
exit $FAIL
