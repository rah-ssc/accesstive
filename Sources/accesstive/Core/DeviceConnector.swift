import Foundation

/// Manages connection to iOS simulators and devices.
struct DeviceConnector: Sendable {
    let deviceId: String

    /// Represents an active session with a device.
    struct Session: Sendable {
        let device: DeviceInfo
        let pid: Int32?
    }

    init(deviceId: String) throws {
        self.deviceId = deviceId
    }

    /// Connect to the target device and return a session.
    func connect() async throws -> Session {
        if deviceId == "booted" {
            return try await connectToBootedSimulator()
        }
        return try await connectToDevice(udid: deviceId)
    }

    /// List available iOS simulators and connected devices.
    static func listDevices(bootedOnly: Bool) async throws -> [DeviceInfo] {
        var devices = try await listSimulators(bootedOnly: bootedOnly)
        let physicalDevices = try await listPhysicalDevices()
        devices.append(contentsOf: physicalDevices)
        return devices
    }

    // MARK: - Simulator Connection

    private func connectToBootedSimulator() async throws -> Session {
        let devices = try await Self.listSimulators(bootedOnly: true)
        guard let device = devices.first else {
            throw AccesstiveError.simulatorNotBooted
        }
        return Session(device: device, pid: nil)
    }

    private func connectToDevice(udid: String) async throws -> Session {
        let allDevices = try await Self.listDevices(bootedOnly: false)
        guard let device = allDevices.first(where: { $0.udid == udid }) else {
            throw AccesstiveError.deviceNotFound(udid)
        }
        return Session(device: device, pid: nil)
    }

    // MARK: - simctl Integration

    private static func listSimulators(bootedOnly: Bool) async throws -> [DeviceInfo] {
        let output = try await shell("xcrun", "simctl", "list", "devices", "-j", "available")

        guard let data = output.data(using: .utf8),
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let devicesByRuntime = json["devices"] as? [String: [[String: Any]]]
        else {
            return []
        }

        var devices: [DeviceInfo] = []

        for (_, runtimeDevices) in devicesByRuntime {
            for entry in runtimeDevices {
                guard let udid = entry["udid"] as? String,
                    let name = entry["name"] as? String,
                    let stateStr = entry["state"] as? String
                else { continue }

                let state: DeviceInfo.DeviceState = stateStr == "Booted" ? .booted : .shutdown

                if bootedOnly && state != .booted { continue }

                devices.append(
                    DeviceInfo(
                        udid: udid,
                        name: name,
                        state: state,
                        isSimulator: true
                    ))
            }
        }

        return devices
    }

    // MARK: - Shell Execution

    static func shell(_ args: String...) async throws -> String {
        try await shellArray(args)
    }

    static func shellArray(_ args: [String]) async throws -> String {
        let process = Process()
        let pipe = Pipe()

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Physical Device Discovery

    private static func listPhysicalDevices() async throws -> [DeviceInfo] {
        // Use idevice_id to list connected USB devices
        let output = try await shell("idevice_id", "-l")
        let udids = output.split(separator: "\n").map(String.init).filter { !$0.isEmpty }

        var devices: [DeviceInfo] = []
        for udid in udids {
            let name =
                (try? await shell("ideviceinfo", "-u", udid, "-k", "DeviceName"))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown"

            devices.append(
                DeviceInfo(
                    udid: udid,
                    name: name,
                    state: .connected,
                    isSimulator: false
                ))
        }
        return devices
    }
}
