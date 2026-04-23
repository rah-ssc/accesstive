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

    @Option(name: .long, help: "Optional expected announcement text for validation.")
    var expectedText: String?

    func run() async throws {
        let connector = try DeviceConnector(deviceId: device)
        let session = try await connector.connect()
        let announcementFilter = AnnouncementEventFilter()

        if session.device.isSimulator {
            try await streamFromSimulator(session: session, filter: announcementFilter)
            return
        }

        try await streamFromPhysicalDevice(udid: session.device.udid, filter: announcementFilter)
    }

    private func streamFromSimulator(session: DeviceConnector.Session, filter: AnnouncementEventFilter) async throws {
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
                let type = classifyEventType(name: "simulator-log", text: message)
                let screen = inferScreenName(from: json, bundleId: bundleId)
                let elementLabel = inferElementLabel(from: json, fallbackText: message)
                let elementIdentifier = inferElementIdentifier(from: json, bundleId: bundleId)

                guard let event = buildAnnouncementEvent(
                    timestamp: timestamp,
                    type: type,
                    text: message,
                    screen: screen,
                    elementLabel: elementLabel,
                    elementIdentifier: elementIdentifier,
                    source: "voiceover",
                    expectedText: expectedText,
                    rawEventName: "simulator-log"
                ) else {
                    continue
                }

                guard filter.shouldEmit(event) else {
                    continue
                }

                emitJsonLine(event)
            }
        } catch {
            if process.isRunning {
                process.terminate()
            }
            throw error
        }
    }

    private func streamFromPhysicalDevice(udid: String, filter: AnnouncementEventFilter) async throws {
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
                guard let normalized = normalizeAnnouncementEvent(event) else {
                    continue
                }

                guard filter.shouldEmit(normalized) else {
                    continue
                }

                emitJsonLine(normalized)
            }
        }
    }

    private func makeSimulatorPredicate(bundleId: String?) -> String {
        let base = "eventMessage != '' AND (subsystem CONTAINS[c] 'accessibility' OR category CONTAINS[c] 'Accessibility' OR process CONTAINS[c] 'SpringBoard' OR process CONTAINS[c] 'backboardd' OR eventMessage CONTAINS[c] 'VoiceOver' OR eventMessage CONTAINS[c] 'UIAccessibility' OR eventMessage CONTAINS[c] 'announcement' OR eventMessage CONTAINS[c] 'screen changed' OR eventMessage CONTAINS[c] 'layout changed' OR eventMessage CONTAINS[c] 'focused' OR eventMessage CONTAINS[c] 'selected' OR eventMessage CONTAINS[c] 'activate' OR eventMessage CONTAINS[c] 'alert' OR eventMessage CONTAINS[c] 'updated' OR eventMessage CONTAINS[c] 'value changed')"

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
            "updated",
            "value changed",
        ]

        return tokens.contains { value.contains($0) }
    }

    private func classifyEventType(name: String, text: String) -> String {
        let value = "\(name) \(text)".lowercased()
        if value.contains("focus") || value.contains("currentelementchanged") {
            return "focus_change"
        }
        if value.contains("alert") {
            return "alert"
        }
        if value.contains("screen changed") || value.contains("layout changed") || (value.contains("screen") && value.contains("changed")) {
            return "screen_change"
        }
        return "dynamic_update"
    }

    private func normalizeAnnouncementEvent(_ event: [String: Any]) -> [String: Any]? {
        let timestamp = (event["timestamp"] as? String) ?? ISO8601DateFormatter().string(from: Date())
        let type = normalizeAnnouncementType(event["type"] as? String ?? event["event_type"] as? String)
        let text = (event["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            return nil
        }

        let screen = (event["screen"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let element = normalizedElement(from: event, fallbackText: text)
        let source = (event["source"] as? String)?.isEmpty == false ? (event["source"] as? String ?? "voiceover") : "voiceover"

        return buildAnnouncementEvent(
            timestamp: timestamp,
            type: type,
            text: text,
            screen: screen,
            elementLabel: element["label"] as? String,
            elementIdentifier: element["id"] as? String,
            source: source,
            expectedText: (event["expectedText"] as? String) ?? expectedText,
            rawEventName: event["raw_event_name"] as? String,
            validation: event["validation"] as? [String: Any]
        )
    }

    private func normalizeAnnouncementType(_ type: String?) -> String {
        switch type?.lowercased() {
        case "alert":
            return "alert"
        case "screen_change":
            return "screen_change"
        case "focus_change":
            return "focus_change"
        case "dynamic_update":
            return "dynamic_update"
        default:
            return "dynamic_update"
        }
    }

    private func buildAnnouncementEvent(
        timestamp: String,
        type: String,
        text: String,
        screen: String,
        elementLabel: String?,
        elementIdentifier: String?,
        source: String,
        expectedText: String?,
        rawEventName: String?,
        validation: [String: Any]? = nil
    ) -> [String: Any]? {
        let element = normalizedElement(label: elementLabel, identifier: elementIdentifier)
        var event: [String: Any] = [
            "timestamp": timestamp,
            "type": type,
            "event_type": type,
            "text": text,
            "screen": screen,
            "element": element,
            "source": source,
        ]

        if let expectedText, !expectedText.isEmpty {
            event["expectedText"] = expectedText
            event["validation"] = validation ?? validationPayload(expected: expectedText, actual: text)
        } else if let validation {
            event["validation"] = validation
        }

        if let rawEventName {
            event["raw_event_name"] = rawEventName
        }

        return event
    }

    private func validationPayload(expected: String, actual: String) -> [String: Any] {
        let matches = normalizedText(expected) == normalizedText(actual)
        return [
            "expectedText": expected,
            "actualText": actual,
            "matches": matches,
            "status": matches ? "match" : "mismatch",
        ]
    }

    private func normalizedText(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func inferScreenName(from json: [String: Any], bundleId: String?) -> String {
        let candidates = [
            json["screen"] as? String,
            json["context"] as? String,
            json["process"] as? String,
            bundleId,
        ]

        for candidate in candidates {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        return ""
    }

    private func inferElementLabel(from json: [String: Any], fallbackText: String) -> String {
        let candidates = [
            json["label"] as? String,
            json["text"] as? String,
            fallbackText,
        ]

        for candidate in candidates {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        return fallbackText
    }

    private func inferElementIdentifier(from json: [String: Any], bundleId: String?) -> String {
        let candidates = [
            json["id"] as? String,
            json["identifier"] as? String,
            bundleId,
            json["process"] as? String,
        ]

        for candidate in candidates {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        return ""
    }

    private func normalizedElement(label: String?, identifier: String?) -> [String: Any] {
        [
            "label": label ?? "",
            "id": identifier ?? "",
        ]
    }

    private func normalizedElement(from event: [String: Any], fallbackText: String) -> [String: Any] {
        if let element = event["element"] as? [String: Any] {
            return normalizedElement(
                label: element["label"] as? String ?? fallbackText,
                identifier: element["id"] as? String
                    ?? element["identifier"] as? String
                    ?? (event["screen"] as? String)
            )
        }

        return normalizedElement(
            label: (event["label"] as? String) ?? fallbackText,
            identifier: (event["id"] as? String) ?? (event["identifier"] as? String)
        )
    }

    private func isNoise(text: String, type: String) -> Bool {
        let value = text.lowercased()
        let genericHints = [
            "double tap to activate",
            "double-tap to activate",
            "swipe up or down",
            "swipe left or right",
            "adjustable",
            "hint",
            "hints available",
        ]

        if type == "dynamic_update" || type == "focus_change" {
            if genericHints.contains(where: { value.contains($0) }) {
                return true
            }
        }

        return false
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

private final class AnnouncementEventFilter {
    private let minimumDuplicateInterval: TimeInterval = 1.5
    private var recentEvents: [String: Date] = [:]

    func shouldEmit(_ event: [String: Any]) -> Bool {
        guard let text = event["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }

        let type = (event["type"] as? String) ?? (event["event_type"] as? String) ?? "dynamic_update"
        if isNoise(text: text, type: type) {
            return false
        }

        let screen = (event["screen"] as? String) ?? ""
        let element = event["element"] as? [String: Any] ?? [:]
        let signature = [
            type,
            text.lowercased(),
            screen.lowercased(),
            (element["label"] as? String ?? "").lowercased(),
            (element["id"] as? String ?? "").lowercased(),
        ].joined(separator: "|")

        let now = Date()
        if let lastSeen = recentEvents[signature], now.timeIntervalSince(lastSeen) < minimumDuplicateInterval {
            return false
        }

        recentEvents[signature] = now
        prune(now: now)
        return true
    }

    private func prune(now: Date) {
        recentEvents = recentEvents.filter { now.timeIntervalSince($0.value) < 8.0 }
    }

    private func isNoise(text: String, type: String) -> Bool {
        let value = text.lowercased()
        let genericHints = [
            "double tap to activate",
            "double-tap to activate",
            "swipe up or down",
            "swipe left or right",
            "adjustable",
            "hint",
            "hints available",
        ]

        if type == "dynamic_update" || type == "focus_change" {
            if genericHints.contains(where: { value.contains($0) }) {
                return true
            }
        }

        return false
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
