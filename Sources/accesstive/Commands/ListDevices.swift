import ArgumentParser
import Foundation

struct ListDevices: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "devices",
        abstract: "List available iOS simulators and connected devices."
    )

    @Flag(name: .long, help: "Show only booted simulators.")
    var bootedOnly: Bool = false

    func run() async throws {
        let devices = try await DeviceConnector.listDevices(bootedOnly: bootedOnly)

        if devices.isEmpty {
            print("No devices found.")
            return
        }

        print("Available devices:")
        print(String(repeating: "-", count: 72))
        print(
            "UDID".padding(toLength: 44, withPad: " ", startingAt: 0)
                + "Name".padding(toLength: 28, withPad: " ", startingAt: 0)
                + "State")
        print(String(repeating: "-", count: 82))

        for device in devices {
            print(
                device.udid.padding(toLength: 44, withPad: " ", startingAt: 0)
                    + device.name.padding(toLength: 28, withPad: " ", startingAt: 0)
                    + device.state.rawValue)
        }
    }
}
