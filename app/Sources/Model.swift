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
  /// The CLI command behind `busy` (e.g. "install-service", "connect-app chatgpt"), so the
  /// step that started it can show its own spinner.
  @Published private(set) var busyCommand: String?
  /// Why the last action failed.
  @Published var problem: String?
  @Published private(set) var brief = ""
  @Published private(set) var appHasFullDiskAccess = false
  /// A newer release on GitHub, from the daily check (or "Check for Updates…").
  @Published private(set) var update: Update?
  /// What the last update check found, for Settings: "Up to date", or why it failed.
  @Published private(set) var updateNote: String?

  struct Update: Decodable, Equatable { let current: String; let latest: String?; let url: String? }

  private var refreshing = false
  /// Callers waiting for a status read that starts after they asked (and whether they want the
  /// full one), so an action never finishes on a status from before it.
  private var waiting: [(full: Bool, done: CheckedContinuation<Void, Never>)] = []
  /// The last "Couldn't check the status" problem, cleared once a check works again.
  private var statusProblem: String?
  /// Rendering previews: show the given state, run nothing.
  private var previewing = false
  private var timer: Timer?

  /// Status first, then the slower interpreter and app checks; then every minute.
  func start() {
    // Run from the disk image or a quarantined copy, it only asks to be moved: nothing it
    // started from there could keep working.
    guard !Backend.mustMove else { return }
    NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in Backend.stopAll() }
    Task {
      await refresh(full: true)
      await repairIfMoved()
      removeLeftoverBackups()
      await restartServiceIfUpdated()
      await checkForUpdates(manual: false)
    }
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
      Task { @MainActor in
        await Model.shared.refresh()
        await Model.shared.checkForUpdates(manual: false)
      }
    }
  }

  /// After the app is replaced by a newer one, the service is still running the old code: restart it.
  private func restartServiceIfUpdated() async {
    guard let s = status, s.install.state == "this", s.install.version != s.version, !Backend.mustMove else { return }
    await act("Updating the background service…", ["install-service"])
  }

  private static let lastUpdateCheck = "lastUpdateCheck"
  /// The copy kept while an update replaces the app; a leftover one (the app quit mid-update) goes on launch.
  private static let backupPrefix = ".Messages Agent previous "

  private func removeLeftoverBackups() {
    let folder = Backend.bundle.deletingLastPathComponent()
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
    for name in names where name.hasPrefix(Self.backupPrefix) && name.hasSuffix(".app") {
      let url = folder.appendingPathComponent(name)
      // Only a real copy of this app (not a link, not anything else).
      guard (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
            Bundle(url: url)?.bundleIdentifier == "com.imessage-agent-mcp.app" else { continue }
      try? FileManager.default.removeItem(at: url)
    }
  }

  /// Once a day (if allowed in Settings), or now when asked: is there a newer release?
  func checkForUpdates(manual: Bool) async {
    if !manual {
      guard status?.config.checkForUpdates ?? true, !Backend.mustMove else { return }
      let last = UserDefaults.standard.double(forKey: Self.lastUpdateCheck)
      guard Date().timeIntervalSince1970 - last > 24 * 3600 else { return }
    }
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastUpdateCheck)
    let res = await Backend.run(["update", "--check"], timeout: 60)
    guard res.ok, let data = res.out.data(using: .utf8), let found = try? JSONDecoder().decode(Update.self, from: data) else {
      if manual { updateNote = "Couldn't check for updates: \(res.reason)" }
      return
    }
    update = found.latest == nil ? nil : found
    updateNote = found.latest.map { "Version \($0) is available." } ?? "Messages Agent is up to date."
  }

  /// Downloads and checks the new version, puts it in place of this app, and reopens it.
  func installUpdate() async {
    guard let latest = update?.latest else { return }
    busy = "Downloading Messages Agent \(latest)…"
    problem = nil
    defer { busy = nil }
    let res = await Backend.run(["update", "--download"], timeout: 900)
    struct Downloaded: Decodable { let version: String; let app: String; let cdhash: String; let readerCdhash: String }
    guard res.ok, let data = res.out.data(using: .utf8), let got = try? JSONDecoder().decode(Downloaded.self, from: data) else {
      problem = "Couldn't download the update: \(res.reason)"
      return
    }
    // Checked again here, on the exact bundle about to be installed: the CLI's check ran a
    // moment ago, in a folder other programs running as you could reach.
    let staged = URL(fileURLWithPath: got.app).standardizedFileURL
    let caches = URL(fileURLWithPath: Backend.home).appendingPathComponent("Library/Caches/imessage-agent-mcp").standardizedFileURL.path + "/update-"
    guard got.version == latest, staged.path.hasPrefix(caches), staged.lastPathComponent == "Messages Agent.app",
          Backend.verifiedCdHash(staged) == got.cdhash
    else {
      problem = "The downloaded update didn't check out, so it wasn't installed."
      return
    }
    let current = Backend.bundle
    let releasePage = update?.url.flatMap(URL.init(string:))
    let running = Backend.verifiedCdHash(current)
    // A name nothing else has, next to the app, so nobody's own folder is ever touched.
    let backupName = "\(Self.backupPrefix)\(UUID().uuidString.prefix(8)).app"
    let backup = current.deletingLastPathComponent().appendingPathComponent(backupName)
    do {
      _ = try FileManager.default.replaceItemAt(current, withItemAt: staged, backupItemName: backupName, options: .withoutDeletingBackupItem)
    } catch {
      problem = "Couldn't replace the app (\(error.localizedDescription)). Download it from GitHub instead."
      if let releasePage { NSWorkspace.shared.open(releasePage) }
      return
    }
    guard Backend.verifiedCdHash(current) == got.cdhash else {
      // Put this version back rather than leave an app that didn't check out.
      let restored = (try? FileManager.default.replaceItemAt(current, withItemAt: backup)) != nil
      if restored, running != nil, Backend.verifiedCdHash(current) == running {
        problem = "The installed update didn't check out, so this version was put back."
      } else {
        problem = "The installed update didn't check out, and this version couldn't be put back. Download Messages Agent again from GitHub."
        if let releasePage { NSWorkspace.shared.open(releasePage) }
      }
      return
    }
    try? FileManager.default.removeItem(at: backup)
    // The new copy restarts the background service when it opens (its version changed).
    let config = NSWorkspace.OpenConfiguration()
    config.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: current, configuration: config) { _, _ in
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  /// Reads the status; returns once a read that started after this call has finished.
  func refresh(full: Bool = false) async {
    guard !previewing, !Backend.mustMove else { return }
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      waiting.append((full, done))
      guard !refreshing else { return }
      refreshing = true
      Task { await drainRefreshes() }
    }
  }

  private func drainRefreshes() async {
    while !waiting.isEmpty {
      let batch = waiting
      waiting = []
      await refreshOnce(full: batch.contains { $0.full })
      for w in batch { w.done.resume() }
    }
    refreshing = false
  }

  private func refreshOnce(full: Bool) async {
    appHasFullDiskAccess = Backend.appHasFullDiskAccess
    if appHasFullDiskAccess {
      problem = Backend.fullDiskAccessProblem
      return
    }
    let res = await Backend.run(["status", "--json"] + (full ? ["--interpreters", "--apps"] : []), timeout: 90)
    guard res.ok, let data = res.out.data(using: .utf8), let next = try? JSONDecoder().decode(Status.self, from: data) else {
      problem = "Couldn't check the status: \(res.reason)"
      statusProblem = problem
      return
    }
    if problem != nil && problem == statusProblem { problem = nil }
    statusProblem = nil
    status = next
    if let i = next.interpreters { interpreters = i }
    if let a = next.apps { apps = a }
  }

  /// Runs one CLI command as a user action, then refreshes. True if it succeeded.
  @discardableResult
  func act(_ label: String, _ args: [String], full: Bool = false) async -> Bool {
    busy = label
    busyCommand = args.joined(separator: " ")
    problem = nil
    let res = await Backend.run(args)
    if !res.ok { problem = res.reason }
    // The quick status first, so the change shows right away; then the slower checks.
    await refresh()
    busy = nil
    busyCommand = nil
    if full { await refresh(full: true) }
    return res.ok
  }

  func useInterpreter(_ name: String) async {
    await act("Switching to \(name == "codex" ? "Codex" : "Claude Code")…", ["use", name], full: true)
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
      for app in apps where app.connected || app.elsewhere == true { await setConnected(app, true) }
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
    previewing = true
    self.status = status
    interpreters = status.interpreters ?? []
    apps = status.apps ?? []
    previewMustMove = mustMoveFirst
  }
  @Published private(set) var previewMustMove = false

  /// One line for the menu.
  var summary: String {
    if appHasFullDiskAccess { return "Switch off Full Disk Access for Messages Agent" }
    if Backend.mustMove { return "Move Messages Agent to Applications first" }
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

  /// Checks again whether the app itself still has Full Disk Access (it shouldn't).
  func recheckAppAccess() async {
    appHasFullDiskAccess = Backend.appHasFullDiskAccess
    if !appHasFullDiskAccess {
      if problem == Backend.fullDiskAccessProblem { problem = nil }
      await refresh(full: true)
    }
  }
}
