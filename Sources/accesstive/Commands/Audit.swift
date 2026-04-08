import ArgumentParser
import Foundation

struct Audit: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Run accessibility audit rules against an iOS app."
    )

    @Option(name: .shortAndLong, help: "Target device UDID. Use 'booted' for the booted simulator.")
    var device: String = "booted"

    @Option(name: .shortAndLong, help: "Bundle identifier of the app to audit.")
    var bundleId: String?

    @Option(name: .shortAndLong, help: "Output format: text, json, or junit.")
    var format: OutputFormat = .text

    @Option(name: .long, help: "Minimum severity to report: hint, warning, error.")
    var minSeverity: Severity = .warning

    @Option(name: .shortAndLong, help: "Comma-separated rule IDs to run. Default: all.")
    var rules: String?

    @Flag(name: .long, help: "Fail with exit code 1 if any issues are found.")
    var strict: Bool = false

    func run() async throws {
        let connector = try DeviceConnector(deviceId: device)
        let session = try await connector.connect()

        let inspector = AccessibilityInspector(session: session)
        let tree = try await inspector.captureTree(bundleId: bundleId)

        let enabledRuleIds = rules?.split(separator: ",").map(String.init)
        let engine = RulesEngine(enabledRuleIds: enabledRuleIds, minSeverity: minSeverity)
        let issues = engine.evaluate(tree: tree)

        let reporter = AuditReporter(format: format)
        let output = reporter.report(issues: issues)
        print(output)

        if strict && !issues.isEmpty {
            throw ExitCode(1)
        }
    }
}
