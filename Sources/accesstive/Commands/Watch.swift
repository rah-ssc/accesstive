import ArgumentParser
import Foundation

struct Watch: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Continuously watch and report accessibility changes in real time."
    )

    @Option(name: .shortAndLong, help: "Target device UDID. Use 'booted' for the booted simulator.")
    var device: String = "booted"

    @Option(name: .shortAndLong, help: "Bundle identifier of the app to watch.")
    var bundleId: String?

    @Option(name: .long, help: "Polling interval in seconds.")
    var interval: Double = 2.0

    func run() async throws {
        let connector = try DeviceConnector(deviceId: device)
        let session = try await connector.connect()

        let inspector = AccessibilityInspector(session: session)

        print("Watching accessibility tree (Ctrl+C to stop)...")
        print()

        var previousSnapshot: String?

        while !Task.isCancelled {
            let tree = try await inspector.captureTree(bundleId: bundleId)
            let formatter = OutputFormatter(format: .tree, includeFrames: false)
            let snapshot = formatter.format(tree: tree)

            if snapshot != previousSnapshot {
                let timestamp = ISO8601DateFormatter().string(from: Date())
                print("[\(timestamp)] Accessibility tree changed:")
                print(snapshot)
                print()
                previousSnapshot = snapshot
            }

            try await Task.sleep(for: .seconds(interval))
        }
    }
}
