import ArgumentParser
import Foundation

struct Announcements: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Capture VoiceOver/system accessibility announcements as a JSON event stream."
    )

    @Option(name: .shortAndLong, help: "Target device UDID. Use 'booted' for the booted simulator.")
    var device: String = "booted"

    @Option(name: .shortAndLong, help: "Optional bundle identifier filter for simulator logs.")
    var bundleId: String?

    @Option(name: .long, help: "Optional duration in seconds; without this, the stream runs until interrupted.")
    var duration: Double?

    func run() async throws {
        let connector = try DeviceConnector(deviceId: device)
        let session = try await connector.connect()

        if session.device.isSimulator {
            try await streamFromSimulator(session: session)
            return
        }

        try await streamFromPhysicalDevice(udid: session.device.udid)
    }

    private func streamFromSimulator(session: DeviceConnector.Session) async throws {
        let process = Process()
        let stdout = Pipe()

        let predicate = makeSimulatorPredicate(bundleId: bundleId)

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "xcrun",
            "simctl",
            "spawn",
            session.device.udid,
            "log",
            "stream",
            "--style",
            "json",
            "--level",
            "info",
            "--predicate",
            predicate,
        ]
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        try process.run()

        if let duration {
            Task {
                try? await Task.sleep(for: .seconds(duration))
                if process.isRunning {
                    process.terminate()
                }
            }
        }

        do {
            for try await line in stdout.fileHandleForReading.bytes.lines {
                guard let payload = line.data(using: .utf8),
                    let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
                else {
                    continue
                }

                guard let message = (json["eventMessage"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                    !message.isEmpty
                else {
                    continue
                }

                guard isAccessibilityRelevant(message: message) else {
                    continue
                }

                let timestamp = (json["timestamp"] as? String) ?? ISO8601DateFormatter().string(from: Date())

                let event: [String: Any] = [
                    "timestamp": timestamp,
                    "event_type": classifyEventType(name: "simulator-log", text: message),
                    "text": message,
                    "source": "simulator",
                    "raw_event_name": "simulator-log",
                ]

                emitJsonLine(event)
            }
        } catch {
            if process.isRunning {
                process.terminate()
            }
            throw error
        }
    }

    private func streamFromPhysicalDevice(udid: String) async throws {
        let bridge = AnnouncementBridge(udid: udid)
        defer { bridge.stop() }

        try bridge.start()

        let connectResult = try bridge.send(["action": "connect", "udid": udid])
        guard connectResult["ok"] != nil else {
            let reason = connectResult["error"] as? String ?? "Unable to connect"
            throw AccesstiveError.connectionFailed(reason)
        }

        let monitorResult = try bridge.send(["action": "monitor_announcements"])
        guard monitorResult["ok"] != nil else {
            let reason = monitorResult["error"] as? String ?? "Unable to start announcement monitor"
            throw AccesstiveError.connectionFailed(reason)
        }

        if let duration {
            Task {
                try? await Task.sleep(for: .seconds(duration))
                bridge.stop()
            }
        }

        while true {
            let line = try bridge.readLineJson()
            if line["type"] as? String == "announcement:event",
                let event = line["event"] as? [String: Any]
            {
                emitJsonLine(event)
            }
        }
    }

    private func makeSimulatorPredicate(bundleId: String?) -> String {
        let base = "eventMessage != '' AND (subsystem CONTAINS[c] 'accessibility' OR category CONTAINS[c] 'Accessibility' OR process CONTAINS[c] 'SpringBoard' OR process CONTAINS[c] 'backboardd' OR eventMessage CONTAINS[c] 'VoiceOver' OR eventMessage CONTAINS[c] 'UIAccessibility' OR eventMessage CONTAINS[c] 'announcement' OR eventMessage CONTAINS[c] 'screen changed' OR eventMessage CONTAINS[c] 'layout changed' OR eventMessage CONTAINS[c] 'focused' OR eventMessage CONTAINS[c] 'selected' OR eventMessage CONTAINS[c] 'activate' OR eventMessage CONTAINS[c] 'alert')"

        guard let bundleId, !bundleId.isEmpty else {
            return base
        }

        return "(\(base)) AND (process CONTAINS[c] '\(bundleId)' OR processImagePath CONTAINS[c] '\(bundleId)' OR senderImagePath CONTAINS[c] '\(bundleId)')"
    }

    private func isAccessibilityRelevant(message: String) -> Bool {
        let value = message.lowercased()
        let tokens = [
            "voiceover",
            "uiaccessibility",
            "announcement",
            "screen",
            "layout",
            "alert",
            "focused",
            "focus",
            "selected",
            "activate",
            "button",
            "tab",
            "cell",
        ]

        return tokens.contains { value.contains($0) }
    }

    private func classifyEventType(name: String, text: String) -> String {
        let value = "\(name) \(text)".lowercased()
        if value.contains("alert") {
            return "alert"
        }
        if value.contains("screen") || value.contains("layout") {
            return "screen_change"
        }
        return "announcement"
    }

    private func emitJsonLine(_ event: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(event),
            let data = try? JSONSerialization.data(withJSONObject: event),
            let line = String(data: data, encoding: .utf8)
        else {
            return
        }
        print(line)
    }
}

private final class AnnouncementBridge: @unchecked Sendable {
    private let udid: String
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?

    init(udid: String) {
        self.udid = udid
    }

    func start() throws {
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let pythonBin = ProcessInfo.processInfo.environment["ACCESSTIVE_PYTHON"] ?? "python3.11"

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [pythonBin, bridgeScriptPath()]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        try process.run()

        self.process = process
        self.stdinPipe = stdin
        self.stdoutPipe = stdout

        let ready = try readLineJson()
        guard ready["ready"] as? Bool == true else {
            throw AccesstiveError.connectionFailed("Bridge failed to start")
        }
    }

    func send(_ command: [String: String]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: command)
        guard var line = String(data: data, encoding: .utf8) else {
            throw AccesstiveError.connectionFailed("Failed to encode bridge command")
        }
        line += "\n"

        stdinPipe?.fileHandleForWriting.write(Data(line.utf8))

        while true {
            let payload = try readLineJson()
            if payload["type"] as? String == "announcement:event" {
                continue
            }
            return payload
        }
    }

    func readLineJson() throws -> [String: Any] {
        guard let handle = stdoutPipe?.fileHandleForReading else {
            throw AccesstiveError.connectionFailed("Bridge not running")
        }

        var buffer = Data()
        while true {
            let byte = handle.readData(ofLength: 1)
            if byte.isEmpty {
                throw AccesstiveError.connectionFailed("Bridge process terminated")
            }
            if byte.first == UInt8(ascii: "\n") {
                break
            }
            buffer.append(byte)
        }

        guard let line = String(data: buffer, encoding: .utf8),
            let data = line.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw AccesstiveError.connectionFailed("Invalid response from bridge")
        }

        return json
    }

    func stop() {
        _ = try? send(["action": "disconnect"])
        stdinPipe?.fileHandleForWriting.closeFile()
        process?.terminate()
        process = nil
    }

    private func bridgeScriptPath() -> String {
        let execURL = URL(fileURLWithPath: CommandLine.arguments[0])
        let scriptDir = execURL.deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Scripts")
            .appendingPathComponent("accesstive-bridge.py")

        if FileManager.default.fileExists(atPath: scriptDir.path) {
            return scriptDir.path
        }

        let candidates = [
            "\(FileManager.default.currentDirectoryPath)/Scripts/accesstive-bridge.py",
            "\(NSHomeDirectory())/accesstive/Scripts/accesstive-bridge.py",
        ]

        for path in candidates where FileManager.default.fileExists(atPath: path) {
            return path
        }

        return "Scripts/accesstive-bridge.py"
    }
}
