// Real HID-level input via CGEvent, for the macOS native-window gate
// (scripts/verify-close-to-background-macos.sh). Compiled on demand by that script.
//
//   macos-hid click X Y              real left click at screen point (AX coordinates)
//   macos-hid key <keycode> [cmd] [ctrl]   real key press (13 = w, 12 = q, 3 = f)
//
// Why not System Events: `AXPress` on the green zoom button and AX `keystroke`
// drove AppKit's fullscreen state machine into a half-state in ~50% of rounds
// (toggleFullScreen: then ignored from any caller until ⌃⌘F). Real CGEvents: 16/16.
import CoreGraphics
import Foundation
let a = CommandLine.arguments
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap); usleep(30_000) }
if a.count >= 4 && a[1] == "click" {
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    usleep(150_000)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
} else if a.count >= 3 && a[1] == "key" {
    let code = CGKeyCode(UInt16(a[2])!)
    var flags: CGEventFlags = []
    if a.contains("cmd") { flags.insert(.maskCommand) }
    if a.contains("ctrl") { flags.insert(.maskControl) }
    let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true); d?.flags = flags; post(d)
    let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false); u?.flags = flags; post(u)
}
