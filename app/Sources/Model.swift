import AppKit
import Foundation
import ServiceManagement

/// The app's state: the last status from the CLI, plus whatever action is running.
@MainActor
final class Model: ObservableObject {
  static let shared = Model()

  @Published private(set) var status: Status?
  @Published private(set) var interpreters: [Status.Interpreter] = []
  @Published private(set) var apps: [Status.AppInfo] = []
  /// What's running right now, e.g. "Installing the background service…".
  @Published private(set) var busy: String?
  /// Why the last action failed.
  @Published var problem: String?
  @Published private(set) var brief = ""
  @Published private(set) var appHasFullDiskAccess = false

  private var refreshing = false
  private var timer: Timer?

  /// Status first, then the slower interpreter and app checks; then every minute.
  func start() {
    Task {
      await refresh(full: true)
      await repairIfMoved()
    }
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
      Task { @MainActor in await Model.shared.refresh() }
    }
  }

  func refresh(full: Bool = false) async {
    if refreshing { return }
    refreshing = true
    defer { refreshing = false }
    let res = await Backend.run(["status", "--json"] + (full ? ["--interpreters", "--apps"] : []), timeout: 90)
    appHasFullDiskAccess = Backend.appHasFullDiskAccess
    guard res.ok, let data = res.out.data(using: .utf8), let next = try? JSONDecoder().decode(Status.self, from: data) else {
      problem = "Couldn't check the status: \(res.reason)"
      return
    }
    status = next
    if let i = next.interpreters { interpreters = i }
    if let a = next.apps { apps = a }
  }

  /// Runs one CLI command as a user action, then refreshes. True if it succeeded.
  @discardableResult
  func act(_ label: String, _ args: [String], full: Bool = false) async -> Bool {
    busy = label
    problem = nil
    let res = await Backend.run(args)
    busy = nil
    if !res.ok { problem = res.reason }
    await refresh(full: full)
    return res.ok
  }

  func useInterpreter(_ name: String) async {
    await act("Switching to \(name)…", ["use", name], full: true)
  }

  func installService() async {
    await act("Installing the background service…", ["install-service"])
  }

  func setConnected(_ app: Status.AppInfo, _ on: Bool) async {
    await act(on ? "Connecting \(app.name)…" : "Disconnecting \(app.name)…", [on ? "connect-app" : "disconnect-app", app.id], full: true)
  }

  func setConfig(_ key: String, _ json: String) async {
    await act("Saving…", ["config", "set", key, json])
  }

  /// Asks the background service to read new messages now.
  func checkNow() async {
    await act("Checking new messages…", ["call", "refresh", "{}"])
  }

  func loadBrief() async {
    let res = await Backend.run(["brief"])
    brief = res.ok ? res.out : "Couldn't load the brief: \(res.reason)"
  }

  func uninstall(deleteData: Bool) async -> Bool {
    try? await SMAppService.mainApp.unregister()
    return await act("Uninstalling…", ["uninstall"] + (deleteData ? ["--delete-data"] : []), full: true)
  }

  /// If the app was moved, the background service and app connections still point at the old
  /// copy: reinstall them here, keeping the apps that were connected.
  private func repairIfMoved() async {
    guard let s = status, s.install.state == "other", let program = s.install.program,
          program.contains(".app/Contents/Resources/app/"), !FileManager.default.fileExists(atPath: program), !Backend.mustMove
    else { return }
    if await act("Updating after the app moved…", ["install-service"]) {
      for app in apps where app.connected { await setConnected(app, true) }
    }
  }

  var openAtLogin: Bool {
    get { SMAppService.mainApp.status == .enabled }
    set {
      do {
        if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      } catch {
        problem = "Couldn't change Open at Login: \(error.localizedDescription)"
      }
      objectWillChange.send()
    }
  }

  /// For `--render-previews`: shows a given state without running anything.
  func preview(_ status: Status, mustMoveFirst: Bool = false) {
    self.status = status
    interpreters = status.interpreters ?? []
    apps = status.apps ?? []
    previewMustMove = mustMoveFirst
  }
  @Published private(set) var previewMustMove = false

  /// One line for the menu.
  var summary: String {
    guard let s = status else { return "Checking…" }
    if !s.serviceReady { return "Not set up yet" }
    switch s.reader.access {
    case "ok":
      let open = s.items.open == 1 ? "1 open item" : "\(s.items.open) open items"
      return "Running · \(open)"
    case "needed": return "Needs Full Disk Access for the reader"
    case "stale": return "The reader isn't answering"
    case "failed": return "Couldn't copy Messages; retrying"
    default: return "Starting…"
    }
  }

  var needsAttention: Bool { !(status?.ready ?? true) || appHasFullDiskAccess }
}
