import Foundation

/// Errors specific to the accesstive tool.
enum AccesstiveError: LocalizedError {
    case deviceNotFound(String)
    case connectionFailed(String)
    case appNotRunning(String)
    case accessibilityNotEnabled
    case simulatorNotBooted
    case xcodeToolsNotInstalled
    case timeout

    var errorDescription: String? {
        switch self {
        case .deviceNotFound(let id):
            return "Device not found: \(id)"
        case .connectionFailed(let reason):
            return "Connection failed: \(reason)"
        case .appNotRunning(let bundleId):
            return "App not running: \(bundleId)"
        case .accessibilityNotEnabled:
            return
                "Accessibility is not enabled. Go to System Settings > Privacy & Security > Accessibility and grant access to Terminal."
        case .simulatorNotBooted:
            return "No simulator is currently booted. Run 'xcrun simctl boot <device>' first."
        case .xcodeToolsNotInstalled:
            return "Xcode command-line tools not found. Install with 'xcode-select --install'."
        case .timeout:
            return "Operation timed out."
        }
    }
}
