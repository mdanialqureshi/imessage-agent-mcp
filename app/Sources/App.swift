import AppKit
import SwiftUI

/// Messages Agent: a menu bar app that sets up and watches the local background service.
/// Quitting it doesn't stop the service; launchd keeps that running.
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
      SetupView().environmentObject(model).showsInDock()
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
    Image(systemName: model.needsAttention ? "exclamationmark.bubble" : "text.bubble")
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
    Button("Quit (the background service keeps running)") { NSApp.terminate(nil) }
  }

  private func open(_ id: String) {
    openWindow(id: id)
    NSApp.activate(ignoringOtherApps: true)
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
      guard s.mode == "app", s.reader.path == Backend.reader.path, s.reader.valid else {
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
