import ArgumentParser
import Foundation

/// Represents a node in the accessibility element tree.
struct AccessibilityNode: Sendable {
    let role: String
    let label: String?
    let value: String?
    let hint: String?
    let traits: [String]
    let frame: CGRect
    let identifier: String?
    let isEnabled: Bool
    let children: [AccessibilityNode]

    var hasLabel: Bool { label != nil && !label!.isEmpty }
    var hasHint: Bool { hint != nil && !hint!.isEmpty }
}

/// Represents a connected iOS device or simulator.
struct DeviceInfo: Sendable {
    let udid: String
    let name: String
    let state: DeviceState
    let isSimulator: Bool

    enum DeviceState: String, Sendable {
        case booted = "Booted"
        case shutdown = "Shutdown"
        case connected = "Connected"
        case unknown = "Unknown"
    }
}

/// An accessibility audit issue found by the rules engine.
struct AuditIssue: Sendable {
    let ruleId: String
    let ruleName: String
    let severity: Severity
    let message: String
    let element: AccessibilityNode
    let suggestion: String?
}

/// Severity levels for audit issues.
enum Severity: String, CaseIterable, Sendable, ExpressibleByArgument {
    case hint
    case warning
    case error

    var symbol: String {
        switch self {
        case .hint: return "💡"
        case .warning: return "⚠️"
        case .error: return "❌"
        }
    }

    var rank: Int {
        switch self {
        case .hint: return 0
        case .warning: return 1
        case .error: return 2
        }
    }
}

/// Output formats supported by the tool.
enum OutputFormat: String, CaseIterable, Sendable, ExpressibleByArgument {
    case tree
    case json
    case flat
    case text
    case junit
}
