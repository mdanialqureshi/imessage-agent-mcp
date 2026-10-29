import Foundation
import Security

/// Runs the CLI bundled inside the app (Contents/Resources/app/src/cli.ts) with the app's own
/// Node. The app itself holds no special permissions: only Messages Agent Reader, a separate
/// program it ships and copies to ~/Applications, gets Full Disk Access.
enum Backend {
  static let bundle = Bundle.main.bundleURL
  static let node = bundle.appendingPathComponent("Contents/Helpers/node")
  static let cli = bundle.appendingPathComponent("Contents/Resources/app/src/cli.ts")
  /// The reader the app ships; installing the service copies it to ~/Applications (see the status's reader.path).
  static let shippedReader = bundle.appendingPathComponent("Contents/Helpers/Messages Agent Reader.app")
  static let home = ProcessInfo.processInfo.environment["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? NSHomeDirectory()

  /// Opened from a disk image or a quarantined download, macOS runs a read-only copy from a
  /// random path, which launchd jobs and app connections can't point at.
  static var mustMove: Bool {
    let p = bundle.path
    return p.contains("/AppTranslocation/") || p.hasPrefix("/Volumes/")
  }

  /// A downloaded copy carries macOS's download flag on every file. Approving the app in
  /// Privacy & Security lets the app itself open, but macOS still stops the programs inside it
  /// that launchd starts directly (Node; the reader is copied out without the flag). Once the app runs, it was approved, so
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
    "Messages Agent itself has Full Disk Access. It must not: switch it off in System Settings → Privacy & Security → Full Disk Access (only Messages Agent Reader needs it)."


  static func environment() -> [String: String] {
    // A minimal environment: nothing from wherever the app was opened leaks into the service.
    ["HOME": home, "USER": NSUserName(), "PATH": path, "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory()]
  }

  /// What the app started and hasn't finished, so quitting stops it too: nothing it started
  /// keeps running after it.
  private static let lock = NSLock()
  nonisolated(unsafe) private static var running: [Int32: Process] = [:]

  private static func track(_ p: Process, _ on: Bool) {
    lock.lock()
    defer { lock.unlock() }
    running[p.processIdentifier] = on ? p : nil
  }

  /// Set while an update relaunches the app, so quitting the old copy leaves the service to the new one.
  nonisolated(unsafe) static var keepServiceOnQuit = false

  /// When the app quits: stops the background service and its reader (opening the app starts
  /// them again), unless an update is relaunching it.
  static func stopServiceForQuit() {
    guard !keepServiceOnQuit, !mustMove, !appHasFullDiskAccess else { return }
    _ = run(node, [cli.path, "stop-service"], env: environment(), timeout: 15, quiet: true)
  }

  /// When the app quits: stops everything it started (each in its own process group).
  static func stopAll() {
    lock.lock()
    let all = Array(running.values)
    lock.unlock()
    guard !all.isEmpty else { return }
    for p in all where p.isRunning { kill(-p.processIdentifier, SIGTERM) }
    usleep(500_000)
    for p in all where p.isRunning { kill(-p.processIdentifier, SIGKILL); kill(p.processIdentifier, SIGKILL) }
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
      track(p, true)
      defer { track(p, false) }
      let kill = DispatchWorkItem { forceStop(p) }
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
    track(p, true)
    defer { track(p, false) }
    let pid = p.processIdentifier
    let kill = DispatchWorkItem { forceStop(p) }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: kill)
    var o = Data(), e = Data()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async { o = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    DispatchQueue.global().async { e = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    p.waitUntilExit()
    kill.cancel()
    // Something it started may still hold its output open: stop the rest of its group, and
    // never wait on it for good.
    if group.wait(timeout: .now() + 5) == .timedOut {
      Darwin.kill(-pid, SIGKILL)
      if group.wait(timeout: .now() + 2) == .timedOut { return Output(status: -1, out: "", err: "it left something running that wouldn't stop") }
    }
    return Output(status: p.terminationStatus, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self))
  }

  /// What a copy of this app must satisfy: this app's identifier and, when this app was signed with
  /// a Developer ID, a certificate Apple issued to the same team. Nil if this app can't tell what
  /// it was signed with, so nothing is installed rather than checked less.
  static let installRequirement: String? = {
    var me: SecCode?
    var own: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
          SecCodeCopyStaticCode(me, [], &own) == errSecSuccess, let own,
          SecCodeCopySigningInformation(own, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let info = info as? [String: Any]
    else { return nil }
    let identifier = #"identifier "com.imessage-agent-mcp.app""#
    let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    if flags & SecCodeSignatureFlags.adhoc.rawValue != 0 { return identifier } // Built from a clone.
    guard let team = info[kSecCodeInfoTeamIdentifier as String] as? String else { return nil }
    guard team.range(of: "^[0-9A-Z]{10}$", options: .regularExpression) != nil else { return nil }
    let text = identifier + " and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
      + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement,
          SecStaticCodeCheckValidity(own, [], requirement) == errSecSuccess
    else { return nil }
    return text
  }()

  /// The code hash of an intact copy of this app (every file sealed, every architecture and
  /// nested program checked, installRequirement), or nil.
  static func verifiedCdHash(_ url: URL) -> String? {
    var code: SecStaticCode?
    guard let text = installRequirement, SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return nil }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else { return nil }
    let flags = SecCSFlags(rawValue: UInt32(kSecCSStrictValidate) | UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSCheckNestedCode))
    guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let hash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data
    else { return nil }
    return hash.map { String(format: "%02x", $0) }.joined()
  }

  /// Asks politely, then kills: an interactive shell ignores SIGTERM. The whole process group,
  /// so nothing it started can keep holding its output open.
  static func forceStop(_ p: Process) {
    guard p.isRunning else { return }
    let pid = p.processIdentifier
    kill(-pid, SIGTERM)
    p.terminate()
    DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
      kill(-pid, SIGKILL)
      if p.isRunning { kill(pid, SIGKILL) }
    }
  }

  /// Whether this app itself was given Full Disk Access by mistake (only the reader needs it).
  /// Probes the account's real home folder, not $HOME, and two protected folders, so neither
  /// an overridden HOME nor a missing Messages folder hides it.
  static var appHasFullDiskAccess: Bool {
    let real = getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } } ?? NSHomeDirectory()
    return ["Library/Messages", "Library/Safari", "Library/Mail"].contains { folder in
      (try? FileManager.default.contentsOfDirectory(atPath: "\(real)/\(folder)")) != nil
    }
  }
}

/// What `cli.ts status --json` reports. Never contains message content.
struct Status: Decodable, Equatable {
  struct Install: Decodable, Equatable { let state: String; let program: String?; let version: String? }
  struct Service: Decodable, Equatable { let running: Bool }
  struct Reader: Decodable, Equatable { let path: String; let valid: Bool; let installed: Bool?; let access: String; let changedSinceGrant: Bool?; let messages: Int?; let contacts: Int? }
  struct Interpreter: Decodable, Equatable, Identifiable { let name: String; let ok: Bool; let detail: String; var id: String { name } }
  struct AppInfo: Decodable, Equatable, Identifiable {
    let id: String; let name: String; let installed: Bool; let connected: Bool
    /// Connected to another copy (say, a clone this app replaced): it needs reconnecting.
    let elsewhere: Bool?
  }
  struct Items: Decodable, Equatable { let open: Int; let lastInterpretedAt: String? }
  struct Config: Decodable, Equatable { let autoInterpretMinutes: Int; let firstRunLookbackDays: Int; let privateContacts: [String]; let checkForUpdates: Bool? }

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
