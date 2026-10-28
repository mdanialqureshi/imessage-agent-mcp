import AppKit
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var model: Model
  @State private var contacts = ""
  /// Contacts are only saved once they've loaded, so an early Save can't wipe the list.
  @State private var loadedContacts = false
  @State private var confirmUninstall = false
  @State private var deleteData = false
  @State private var uninstalled = false
  /// The interpreter just picked, shown right away while the switch runs.
  @State private var choice: String?

  private static let intervals = [(0, "Only when an agent asks"), (30, "Every 30 minutes"), (60, "Every hour"), (120, "Every 2 hours"), (240, "Every 4 hours"), (480, "Every 8 hours")]

  var body: some View {
    Form {
      Section("Reading") {
        Picker("Interpreter", selection: Binding(get: { choice ?? model.status?.interpreter ?? "claude" }, set: { name in
          guard name != (model.status?.interpreter ?? "claude") else { return }
          choice = name
          Task {
            await model.useInterpreter(name)
            choice = nil
          }
        })) {
          Text("Claude Code (Claude plan)").tag("claude")
          Text("Codex (ChatGPT plan)").tag("codex")
        }
        .disabled(model.busy != nil)
        Picker("Check new messages", selection: Binding(
          get: { model.status?.config.autoInterpretMinutes ?? 120 },
          set: { minutes in Task { await model.setConfig("autoInterpretMinutes", String(minutes)) } }
        )) {
          ForEach(Self.intervals, id: \.0) { Text($0.1).tag($0.0) }
          if let m = model.status?.config.autoInterpretMinutes, !Self.intervals.contains(where: { $0.0 == m }) {
            Text("Every \(m) minutes").tag(m)
          }
        }
        .disabled(model.busy != nil)
      }
      Section {
        TextEditor(text: $contacts)
          .font(.body)
          .frame(height: 90)
        HStack {
          Spacer()
          Button("Save") {
            guard loadedContacts else { return }
            let list = contacts.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if let data = try? JSONEncoder().encode(list), let json = String(data: data, encoding: .utf8) {
              Task { await model.setConfig("privateContacts", json) }
            }
          }
          .disabled(!loadedContacts || model.busy != nil)
        }
      } header: {
        Text("Private contacts")
      } footer: {
        Text("One name, number or email per line. Their chats are never read or sent anywhere.").foregroundStyle(.secondary)
      }
      Section("App") {
        Toggle("Show in the menu bar at login", isOn: Binding(get: { model.openAtLogin }, set: { model.openAtLogin = $0 }))
        Toggle("Check for updates daily", isOn: Binding(
          get: { model.status?.config.checkForUpdates ?? true },
          set: { on in Task { await model.setConfig("checkForUpdates", on ? "true" : "false") } }
        ))
        .disabled(model.busy != nil)
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Version \(model.status?.version ?? "?")")
            if let note = model.updateNote { Text(note).font(.caption).foregroundStyle(.secondary) }
          }
          Spacer()
          if model.update?.latest != nil {
            Button("Install Update") { Task { await model.installUpdate() } }
              .buttonStyle(.borderedProminent)
              .disabled(model.busy != nil)
          } else {
            Button("Check Now") { Task { await model.checkForUpdates(manual: true) } }
              .disabled(model.busy != nil)
          }
          Button("Uninstall…") { confirmUninstall = true }
        }
        if uninstalled {
          Text("Uninstalled. Now remove Messages Agent Reader from Full Disk Access, quit this app and move it to the Trash.")
            .foregroundStyle(.secondary)
        }
        if let problem = model.problem {
          Text(problem).foregroundStyle(.orange)
        }
      }
    }
    .formStyle(.grouped)
    .frame(width: 480)
    .fixedSize(horizontal: false, vertical: true)
    .onAppear { loadContacts() }
    .onChange(of: model.status?.config.privateContacts) { _ in if !loadedContacts { loadContacts() } }
    .sheet(isPresented: $confirmUninstall) {
      VStack(alignment: .leading, spacing: 14) {
        Text("Uninstall Messages Agent?").font(.headline)
        Text("This disconnects your apps and removes the background service and its copy of Messages.")
        Toggle("Also delete my items and logs", isOn: $deleteData)
        HStack {
          Spacer()
          Button("Cancel") { confirmUninstall = false }
          Button("Uninstall", role: .destructive) {
            confirmUninstall = false
            Task { uninstalled = await model.uninstall(deleteData: deleteData) }
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(20)
      .frame(width: 380)
    }
  }
}

extension SettingsView {
  private func loadContacts() {
    guard let list = model.status?.config.privateContacts else { return }
    contacts = list.joined(separator: "\n")
    loadedContacts = true
  }
}

struct BriefView: View {
  @EnvironmentObject var model: Model

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("What needs attention").font(.headline)
        Spacer()
        Button("Check New Messages Now") { Task { await model.checkNow(); await model.loadBrief() } }
          .disabled(model.busy != nil)
        Button("Reload") { Task { await model.loadBrief() } }
      }
      .padding(14)
      Divider()
      ScrollView {
        Text(model.brief.isEmpty ? "Loading…" : model.brief)
          .font(.system(.body, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
      }
      Text("This is what your agents see. It stays on this Mac until an agent asks for it.")
        .font(.caption).foregroundStyle(.secondary).padding(10)
    }
    .frame(minWidth: 560, minHeight: 480)
    .task { await model.loadBrief() }
  }
}
