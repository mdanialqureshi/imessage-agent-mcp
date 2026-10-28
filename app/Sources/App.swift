import AppKit
import SwiftUI

/// Messages Agent: a menu bar app that sets up and runs the local background service. The
/// service runs while the app is open: quitting stops it, opening starts it again.
@main
enum Main {
  static func main() {
    Backend.clearQuarantine()
    if CommandLine.arguments.contains("--self-test") {
      if Backend.appHasFullDiskAccess { print("self-test failed: \(Backend.fullDiskAccessProblem)"); exit(1) }
      return SelfTest.run()
    }
    if let i = CommandLine.arguments.firstIndex(of: "--render-previews"), i + 1 < CommandLine.arguments.count {
      return Previews.render(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
    }
    IMessageAgentApp.main()
  }
}

struct IMessageAgentApp: App {
  @StateObject private var model = Model.shared

  var body: some Scene {
    MenuBarExtra {
      MenuContent().environmentObject(model)
    } label: {
      MenuLabel().environmentObject(model)
    }
    Window("Set Up Messages Agent", id: "setup") {
      OnboardingView().environmentObject(model).showsInDock()
    }
    .windowResizability(.contentSize)
    Window("Messages Agent", id: "overview") {
      OverviewView().environmentObject(model).showsInDock()
    }
    .windowResizability(.contentSize)
    Window("Brief", id: "brief") {
      BriefView().environmentObject(model).showsInDock()
    }
    Window("Messages Agent Settings", id: "settings") {
      SettingsView().environmentObject(model).showsInDock()
    }
    .windowResizability(.contentSize)
  }
}

/// The menu bar icon. It also opens setup on launch when something needs doing.
struct MenuLabel: View {
  @EnvironmentObject var model: Model
  @Environment(\.openWindow) private var openWindow
  @State private var started = false

  var body: some View {
    Image(nsImage: MenuIcon.image(attention: model.needsAttention))
      .onAppear {
        guard !started else { return }
        started = true
        model.start()
        Task {
          // Wait for the first status before deciding.
          for _ in 0..<100 where model.status == nil && !Backend.mustMove { try? await Task.sleep(nanoseconds: 100_000_000) }
          if Backend.mustMove || !(model.status?.ready ?? false) { open("setup") }
        }
      }
  }

  private func open(_ id: String) {
    openWindow(id: id)
    NSApp.activate(ignoringOtherApps: true)
  }
}

struct MenuContent: View {
  @EnvironmentObject var model: Model
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Text(model.summary)
    if let busy = model.busy { Text(busy) }
    Divider()
    Button("Show Brief") { open("brief") }
      .disabled(!(model.status?.ready ?? false))
    Button("Check New Messages Now") { Task { await model.checkNow() } }
      .disabled(!(model.status?.ready ?? false) || model.busy != nil)
    Divider()
    Button("Overview…") { open("overview") }
    Button("Set Up…") { open("setup") }
    Button("Settings…") { open("settings") }
    if let latest = model.update?.latest {
      Button("Install Update (\(latest))…") { Task { await model.installUpdate() } }
        .disabled(model.busy != nil)
    } else {
      Button("Check for Updates…") {
        Task {
          await model.checkForUpdates(manual: true)
          open("settings")
        }
      }
    }
    Divider()
    Button("Quit Messages Agent") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  private func open(_ id: String) {
    openWindow(id: id)
    NSApp.activate(ignoringOtherApps: true)
  }
}

/// The menu bar icon: a message bubble with the app icon's robot face, drawn as a template so
/// it takes the menu bar's color. Needing attention adds a small dot.
enum MenuIcon {
  static func image(attention: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
      // The bubble, with a short tail at the bottom left.
      let bubble = NSBezierPath(roundedRect: NSRect(x: 2, y: 4.5, width: 15, height: 11.5), xRadius: 4.2, yRadius: 4.2)
      let tail = NSBezierPath()
      tail.move(to: NSPoint(x: 4.6, y: 5.2))
      tail.line(to: NSPoint(x: 3.2, y: 1.6))
      tail.line(to: NSPoint(x: 8.2, y: 4.6))
      tail.close()
      NSColor.black.setFill()
      bubble.fill()
      tail.fill()
      // The robot's face, cut out of the bubble: two square-ish eyes and a smile.
      NSGraphicsContext.current?.compositingOperation = .destinationOut
      NSBezierPath(roundedRect: NSRect(x: 5.9, y: 9.4, width: 2.6, height: 2.6), xRadius: 0.7, yRadius: 0.7).fill()
      NSBezierPath(roundedRect: NSRect(x: 10.5, y: 9.4, width: 2.6, height: 2.6), xRadius: 0.7, yRadius: 0.7).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      let smile = NSBezierPath()
      smile.move(to: NSPoint(x: 7.2, y: 7.6))
      smile.curve(to: NSPoint(x: 11.8, y: 7.6), controlPoint1: NSPoint(x: 8.4, y: 6.3), controlPoint2: NSPoint(x: 10.6, y: 6.3))
      smile.lineWidth = 1.3
      smile.lineCapStyle = .round
      NSGraphicsContext.current?.compositingOperation = .destinationOut
      smile.stroke()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      if attention {
        // A ring of clear space, then the dot, at the top right.
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSBezierPath(ovalIn: NSRect(x: 13.2, y: 11.2, width: 7, height: 7)).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        NSBezierPath(ovalIn: NSRect(x: 14.4, y: 12.4, width: 4.6, height: 4.6)).fill()
      }
      return true
    }
    image.isTemplate = true
    return image
  }
}

extension View {
  /// A menu bar app has no Dock icon; give it one while a window is open, so it can be found.
  func showsInDock() -> some View {
    onAppear {
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
    }
    .onDisappear {
      DispatchQueue.main.async {
        if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) { NSApp.setActivationPolicy(.accessory) }
      }
    }
  }
}

/// `--self-test`: checks the bundled Node and CLI answer and their status decodes, without UI.
enum SelfTest {
  static func run() {
    let res = Backend.run(Backend.node, [Backend.cli.path, "status", "--json"], env: Backend.environment(), timeout: 60)
    guard res.ok, let data = res.out.data(using: .utf8) else {
      print("self-test failed: \(res.reason)")
      exit(1)
    }
    do {
      let s = try JSONDecoder().decode(Status.self, from: data)
      let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
      guard s.mode == "app", s.reader.path == home + "/Applications/Messages Agent Reader.app", s.reader.valid else {
        print("self-test failed: mode=\(s.mode) reader=\(s.reader.path) valid=\(s.reader.valid)")
        exit(1)
      }
      print("self-test ok: version \(s.version), mode \(s.mode), reader signed, install \(s.install.state)")
      exit(0)
    } catch {
      print("self-test failed: \(error)")
      exit(1)
    }
  }
}
