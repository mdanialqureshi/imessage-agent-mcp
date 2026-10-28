import Foundation

/// Runs the CLI bundled inside the app (Contents/Resources/app/src/cli.ts) with the app's own
/// Node. The app itself holds no special permissions: only imessage-agent-reader, a separate
/// program inside it, gets Full Disk Access.
enum Backend {
  static let bundle = Bundle.main.bundleURL
  static let node = bundle.appendingPathComponent("Contents/Helpers/node")
  static let cli = bundle.appendingPathComponent("Contents/Resources/app/src/cli.ts")
  static let reader = bundle.appendingPathComponent("Contents/Helpers/imessage-agent-reader.app")
  static let home = ProcessInfo.processInfo.environment["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? NSHomeDirectory()

  /// Opened from a disk image or a quarantined download, macOS runs a read-only copy from a
  /// random path, which launchd jobs and app connections can't point at.
  static var mustMove: Bool {
    let p = bundle.path
    return p.contains("/AppTranslocation/") || p.hasPrefix("/Volumes/")
  }

  /// A downloaded copy carries macOS's download flag on every file. Approving the app in
  /// Privacy & Security lets the app itself open, but macOS still stops the programs inside it
  /// that launchd starts directly (Node and the reader). Once the app runs, it was approved, so
  /// it clears the flag from its own files; its signature still seals every one of them.
  static func clearQuarantine() {
    guard !mustMove else { return }
    let name = "com.apple.quarantine"
    removexattr(bundle.path, name, XATTR_NOFOLLOW)
    guard let files = FileManager.default.enumerator(atPath: bundle.path) else { return }
    for case let file as String in files { removexattr(bundle.appendingPathComponent(file).path, name, XATTR_NOFOLLOW) }
  }

  /// PATH as your login shell sets it, so `claude` and `codex` are found just like in Terminal.
  /// Only PATH is taken from the shell; no other variables (like API keys) are.
  static let path: String = {
    var dirs: [String] = []
    let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
    // The shell writes PATH to a private file rather than a pipe: something its startup files
    // leave running in the background can hold a pipe open, but can't stop the timeout here.
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("imessage-agent-path-\(UUID().uuidString)")
    if FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) {
      let shellURL = URL(fileURLWithPath: shell)
      _ = run(shellURL, ["-ilc", "printf %s \"$PATH\" > \"$0\"", file.path], env: ["HOME": home, "USER": NSUserName(), "SHELL": shell, "TERM": "dumb"], timeout: 8, quiet: true)
      if let text = try? String(contentsOf: file, encoding: .utf8) { dirs = text.split(separator: ":").map(String.init) }
      try? FileManager.default.removeItem(at: file)
    }
    dirs += ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.npm-global/bin", "\(home)/.bun/bin", "\(home)/.volta/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    var seen = Set<String>()
    return dirs.filter { $0.hasPrefix("/") && seen.insert($0).inserted }.joined(separator: ":")
  }()

  struct Output {
    let status: Int32
    let out: String
    let err: String
    var ok: Bool { status == 0 }
    /// The last line a command printed, for showing why it failed.
    var reason: String {
      let text = (err.isEmpty ? out : err).trimmingCharacters(in: .whitespacesAndNewlines)
      return text.split(separator: "\n").last.map(String.init) ?? "exited with status \(status)"
    }
  }

  /// Runs `cli.ts <args>` off the main thread.
  static func run(_ args: [String], timeout: TimeInterval = 180) async -> Output {
    await Task.detached {
      // Anything this app starts would inherit its Full Disk Access, and Node, the CLI and
      // your shell's startup files are all files other programs could change. So with that
      // access (given by mistake), it starts nothing until it's switched off.
      if appHasFullDiskAccess { return Output(status: -1, out: "", err: fullDiskAccessProblem) }
      return run(node, [cli.path] + args, env: environment(), timeout: timeout)
    }.value
  }

  static let fullDiskAccessProblem =
    "imessage-agent itself has Full Disk Access. It must not: switch it off in System Settings → Privacy & Security → Full Disk Access (only imessage-agent-reader needs it)."


  static func environment() -> [String: String] {
    // A minimal environment: nothing from wherever the app was opened leaks into the service.
    ["HOME": home, "USER": NSUserName(), "PATH": path, "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory()]
  }

  /// `quiet` discards the program's output instead of collecting it, so nothing it leaves
  /// running can hold the call open past its timeout.
  static func run(_ exe: URL, _ args: [String], env: [String: String], timeout: TimeInterval, quiet: Bool = false) -> Output {
    let p = Process()
    p.executableURL = exe
    p.arguments = args
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: home)
    if quiet {
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      p.standardInput = FileHandle.nullDevice
      do { try p.run() } catch { return Output(status: -1, out: "", err: error.localizedDescription) }
      let kill = DispatchWorkItem { if p.isRunning { p.terminate() } }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: kill)
      p.waitUntilExit()
      kill.cancel()
      return Output(status: p.terminationStatus, out: "", err: "")
    }
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return Output(status: -1, out: "", err: error.localizedDescription) }
    let kill = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: kill)
    var o = Data(), e = Data()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async { o = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    DispatchQueue.global().async { e = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    p.waitUntilExit()
    group.wait()
    kill.cancel()
    return Output(status: p.terminationStatus, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self))
  }

  /// Whether this app itself was given Full Disk Access by mistake (only the reader needs it).
  static var appHasFullDiskAccess: Bool {
    (try? FileManager.default.contentsOfDirectory(atPath: "\(home)/Library/Messages")) != nil
  }
}

/// What `cli.ts status --json` reports. Never contains message content.
struct Status: Decodable, Equatable {
  struct Install: Decodable, Equatable { let state: String; let program: String? }
  struct Service: Decodable, Equatable { let running: Bool }
  struct Reader: Decodable, Equatable { let path: String; let valid: Bool; let access: String; let changedSinceGrant: Bool?; let messages: Int?; let contacts: Int? }
  struct Interpreter: Decodable, Equatable, Identifiable { let name: String; let ok: Bool; let detail: String; var id: String { name } }
  struct AppInfo: Decodable, Equatable, Identifiable { let id: String; let name: String; let installed: Bool; let connected: Bool }
  struct Items: Decodable, Equatable { let open: Int; let lastInterpretedAt: String? }
  struct Config: Decodable, Equatable { let autoInterpretMinutes: Int; let firstRunLookbackDays: Int; let privateContacts: [String] }

  let mode: String
  let version: String
  let install: Install
  let service: Service
  let reader: Reader
  let interpreter: String
  let items: Items
  let callCommand: String
  let config: Config
  let interpreters: [Interpreter]?
  let apps: [AppInfo]?

  /// Installed from this copy of the app and running.
  var serviceReady: Bool { install.state == "this" && service.running }
  var ready: Bool { serviceReady && reader.access == "ok" }
}
