import AppKit
import SwiftUI

/// The guided first run: a welcome, then one step per page, then "You're all set". Back and
/// Continue move between pages; a page that must be done first keeps Continue off until it is.
/// Everything is also on one page in OverviewView, from the menu.
struct OnboardingView: View {
  @EnvironmentObject var model: Model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Shows this page right away (for previews); otherwise it starts at the first unfinished step.
  var startPage: Page? = nil
  @State private var page = Page.welcome
  @State private var forward = true
  @State private var placed = false

  enum Page: Int, CaseIterable {
    case welcome, interpreter, service, access, apps, agent, finished
    static let steps: [Page] = [.interpreter, .service, .access, .apps, .agent]
  }

  var body: some View {
    VStack(spacing: 0) {
      if Backend.mustMove || model.previewMustMove {
        Spacer()
        MoveFirst().padding(.horizontal, 48)
        Spacer()
      } else if model.appHasFullDiskAccess {
        Spacer()
        AppHasAccess().padding(.horizontal, 48)
        Spacer()
      } else {
        progress
        ZStack {
          content(page)
            .id(page)
            .transition(transition)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        controls
      }
      StatusFooter()
    }
    .frame(width: 640, height: 620)
    .environment(\.stepStyle, .page)
    .tint(.brand)
    .task { await place() }
  }

  // MARK: Pages

  @ViewBuilder private func content(_ page: Page) -> some View {
    switch page {
    case .welcome: Welcome()
    case .finished: AllSet()
    default:
      ScrollView {
        Group {
          switch page {
          case .interpreter: InterpreterStep()
          case .service: ServiceStep()
          case .access: AccessStep()
          case .apps: AppsStep()
          default: AgentStep()
          }
        }
        .padding(.horizontal, 48)
        .padding(.top, 28)
        .padding(.bottom, 20)
      }
    }
  }

  /// Forward slides in from the right and back from the left, along the same path both ways.
  private var transition: AnyTransition {
    if reduceMotion { return .opacity }
    return .asymmetric(
      insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
      removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity)
    )
  }

  private func go(to next: Page) {
    forward = next.rawValue > page.rawValue
    // The outgoing page picks up the direction before it leaves.
    DispatchQueue.main.async {
      withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.4, dampingFraction: 1)) { page = next }
    }
  }

  /// Steps that have to be done before the next one can start.
  private func done(_ page: Page) -> Bool {
    let s = model.status
    switch page {
    case .interpreter: return model.interpreters.first { $0.name == s?.interpreter }?.ok ?? false
    case .service: return s?.serviceReady ?? false
    case .access: return s?.reader.access == "ok"
    default: return true // Connecting apps and telling your agent are up to you.
    }
  }

  /// Opens at the first step that isn't done, so reopening mid-setup picks up where you were.
  private func place() async {
    guard !placed else { return }
    placed = true
    if let startPage { page = startPage; return }
    for _ in 0..<100 where model.status == nil || model.interpreters.isEmpty {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    guard done(.interpreter) else { return }
    page = [Page.service, .access].first { !done($0) } ?? .welcome
  }

  // MARK: Chrome

  private var progress: some View {
    let index = Page.steps.firstIndex(of: page)
    return HStack(spacing: 6) {
      ForEach(Page.steps.indices, id: \.self) { i in
        Capsule()
          .fill(index.map { i <= $0 } ?? (page == .finished) ? Color.brand : Color.secondary.opacity(0.2))
          .frame(width: 30, height: 4)
      }
    }
    .padding(.top, 22)
    .opacity(page == .welcome ? 0 : 1)
    .animation(.spring(response: 0.4, dampingFraction: 1), value: page)
    .accessibilityElement()
    .accessibilityLabel(index.map { "Step \($0 + 1) of \(Page.steps.count)" } ?? "")
  }

  private var controls: some View {
    HStack {
      if page != .welcome && page != .finished {
        Button("Back") { go(to: Page(rawValue: page.rawValue - 1)!) }
          .controlSize(.large)
          .keyboardShortcut(.cancelAction)
      }
      Spacer()
      if !done(page) {
        Text(hint).font(.callout).foregroundStyle(.secondary).transition(.opacity)
      }
      Button(primaryLabel) {
        if page == .finished { NSApp.keyWindow?.close() } else { go(to: Page(rawValue: page.rawValue + 1)!) }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .keyboardShortcut(.defaultAction)
      .disabled(!done(page))
    }
    .padding(.horizontal, 28)
    .padding(.vertical, 18)
    .animation(.easeOut(duration: 0.15), value: done(page))
  }

  private var primaryLabel: String {
    switch page {
    case .welcome: return "Get Started"
    case .apps where !model.apps.contains(where: \.connected): return "Skip"
    case .agent: return "Finish"
    case .finished: return "Done"
    default: return "Continue"
    }
  }

  private var hint: String {
    switch page {
    case .interpreter: return "Sign in to continue"
    case .service: return "Install to continue"
    case .access: return "Waiting for access"
    default: return ""
    }
  }
}

/// The first page: what it is, in three lines.
private struct Welcome: View {
  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 12)
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 96, height: 96)
        .padding(.bottom, 16)
      Text("Messages Agent")
        .font(.system(size: 32, weight: .bold))
        .tracking(-0.6)
      Text("What you've promised, planned and owe in your texts,\nfor the AI agents you already use.")
        .font(.system(size: 14))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.top, 8)
      VStack(alignment: .leading, spacing: 18) {
        Feature(symbol: "lock.shield", title: "Stays on this Mac", text: "No server, sign-up or network port. Only a tiny reader can see Messages.")
        Feature(symbol: "sparkles", title: "Uses your subscription", text: "Claude Code or Codex reads new conversations. No API keys.")
        Feature(symbol: "hand.raised", title: "You stay in charge", text: "It only reads. Agents ask before adding anything to your calendar.")
      }
      .frame(maxWidth: 420, alignment: .leading)
      .padding(.top, 34)
      Spacer(minLength: 12)
    }
    .padding(.horizontal, 48)
  }
}

private struct Feature: View {
  let symbol: String
  let title: String
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: symbol)
        .font(.system(size: 20, weight: .medium))
        .foregroundStyle(Color.brand)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13.5, weight: .semibold))
        Text(text).font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// The last page.
private struct AllSet: View {
  @EnvironmentObject var model: Model

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 12)
      ZStack {
        Circle().fill(Color.green.opacity(0.13)).frame(width: 88, height: 88)
        Image(systemName: "checkmark").font(.system(size: 38, weight: .semibold)).foregroundStyle(.green)
      }
      .padding(.bottom, 20)
      Text("You're all set")
        .font(.system(size: 30, weight: .bold))
        .tracking(-0.5)
      Text("Messages Agent keeps working in the background, even after you close this window.")
        .font(.system(size: 14))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
        .padding(.top, 8)
      VStack(alignment: .leading, spacing: 18) {
        Feature(symbol: "arrow.clockwise", title: "Restart your AI apps", text: "Claude and ChatGPT load the new connection when they restart.")
        Feature(symbol: "menubar.rectangle", title: "Find it in the menu bar", text: "The brief, the overview of every step, and Settings are all there.")
        Feature(symbol: "text.bubble", title: "Ask away", text: "Try: \"What did I commit to in my texts this week?\"")
      }
      .frame(maxWidth: 420, alignment: .leading)
      .padding(.top, 34)
      Spacer(minLength: 12)
    }
    .padding(.horizontal, 48)
  }
}
