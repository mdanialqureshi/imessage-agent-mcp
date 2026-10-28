import AppKit
import SwiftUI

/// `--render-previews <dir>`: draws the setup and settings windows in each setup state to PNGs,
/// with made-up status, for checking the layout without clicking through a real install.
@MainActor
enum Previews {
  static func render(to dir: URL) {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let model = Model.shared
    let states: [(String, String, Bool)] = [
      ("1-move-first", status(interpreterOK: false, installed: "none", access: "unknown"), true),
      ("2-fresh", status(interpreterOK: false, installed: "none", access: "unknown"), false),
      ("3-other-install", status(interpreterOK: true, installed: "other", access: "unknown"), false),
      ("4-needs-access", status(interpreterOK: true, installed: "this", access: "needed"), false),
      ("5-ready", status(interpreterOK: true, installed: "this", access: "ok", connected: true), false),
    ]
    for (name, json, move) in states {
      model.preview(try! JSONDecoder().decode(Status.self, from: Data(json.utf8)), mustMoveFirst: move)
      for dark in [false, true] {
        let suffix = dark ? "-dark" : ""
        snapshot(SetupView().environmentObject(model), size: NSSize(width: 620, height: 720), dark: dark, to: dir.appendingPathComponent("setup-\(name)\(suffix).png"))
        if name == "5-ready" {
          snapshot(SettingsView().environmentObject(model), size: NSSize(width: 480, height: 600), dark: dark, to: dir.appendingPathComponent("settings\(suffix).png"))
        }
        if name == "4-needs-access" {
          // The whole scroll content, to check every step.
          snapshot(SetupView().environmentObject(model).frame(height: 1500), size: NSSize(width: 620, height: 1500), dark: dark, to: dir.appendingPathComponent("setup-\(name)-full\(suffix).png"))
        }
      }
    }
    print("rendered previews to \(dir.path)")
    exit(0)
  }

  private static func snapshot<V: View>(_ view: V, size: NSSize, dark: Bool, to url: URL) {
    let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
    host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    host.frame = NSRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
    host.cacheDisplay(in: host.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
  }

  private static func status(interpreterOK: Bool, installed: String, access: String, connected: Bool = false) -> String {
    """
    {"mode":"app","version":"0.2.0","install":{"state":"\(installed)","program":\(installed == "other" ? "\"/Users/you/imessage-agent-mcp/src/cli.ts\"" : "null")},
     "service":{"running":\(installed != "none")},
     "reader":{"path":"/Applications/Messages Agent.app/Contents/Helpers/Messages Agent Reader.app","valid":true,"access":"\(access)"\(access == "ok" ? ",\"messages\":48213,\"contacts\":512" : "")},
     "interpreter":"claude","items":{"open":7,"lastInterpretedAt":null},
     "callCommand":"'/Applications/Messages Agent.app/Contents/Helpers/node' '/Applications/Messages Agent.app/Contents/Resources/app/src/cli.ts' call",
     "config":{"autoInterpretMinutes":120,"firstRunLookbackDays":7,"privateContacts":["Sam Example"]},
     "interpreters":[{"name":"claude","ok":\(interpreterOK),"detail":"\(interpreterOK ? "signed in with a Claude plan" : "not installed")"},{"name":"codex","ok":false,"detail":"not installed"}],
     "apps":[{"id":"chatgpt","name":"ChatGPT desktop app & Codex (for Dot)","installed":true,"connected":\(connected)},
             {"id":"claude-desktop","name":"Claude desktop app","installed":true,"connected":\(connected)},
             {"id":"claude-code","name":"Claude Code","installed":true,"connected":false},
             {"id":"cursor","name":"Cursor","installed":false,"connected":false}]}
    """
  }
}
