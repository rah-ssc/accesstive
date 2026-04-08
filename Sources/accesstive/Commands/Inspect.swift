import ArgumentParser
import Foundation

struct Inspect: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Inspect the accessibility tree of a running iOS app."
    )

    @Option(name: .shortAndLong, help: "Target device UDID. Use 'booted' for the booted simulator.")
    var device: String = "booted"

    @Option(name: .shortAndLong, help: "Bundle identifier of the app to inspect.")
    var bundleId: String?

    @Option(name: .shortAndLong, help: "Output format: tree, json, or flat.")
    var format: OutputFormat = .tree

    @Flag(name: .long, help: "Include frame coordinates in output.")
    var includeFrames: Bool = false

    @Option(name: .long, help: "Maximum depth of the accessibility tree to traverse.")
    var maxDepth: Int = Int.max

    func run() async throws {
        let connector = try DeviceConnector(deviceId: device)
        let session = try await connector.connect()

        let inspector = AccessibilityInspector(session: session)
        let tree = try await inspector.captureTree(
            bundleId: bundleId,
            maxDepth: maxDepth
        )

        let formatter = OutputFormatter(format: format, includeFrames: includeFrames)
        let output = formatter.format(tree: tree)
        print(output)
    }
}
