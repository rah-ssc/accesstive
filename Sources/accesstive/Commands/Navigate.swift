import ArgumentParser
import Foundation

struct Navigate: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Interactively navigate accessibility elements on a physical iOS device."
    )

    @Option(name: .shortAndLong, help: "Target device UDID.")
    var device: String

    func run() async throws {
        let bridge = try BridgeProcess(udid: device)
        defer { bridge.stop() }

        try bridge.start()

        let connectResult = try bridge.send(["action": "connect", "udid": device])
        guard connectResult["ok"] != nil else {
            let err = connectResult["error"] as? String ?? "Connection failed"
            throw AccesstiveError.connectionFailed(err)
        }

        print("Connected to device: \(device)")
        printHelp()

        // Move to first element
        let firstResult = try bridge.send(["action": "first"])
        printElement(firstResult)

        // Interactive loop
        while true {
            print("\n\u{001B}[36maccesstive>\u{001B}[0m ", terminator: "")
            guard let input = readLine()?.trimmingCharacters(in: .whitespaces).lowercased(),
                !input.isEmpty
            else {
                continue
            }

            switch input {
            case "n", "next":
                let r = try bridge.send(["action": "next"])
                printElement(r)
            case "p", "prev", "previous":
                let r = try bridge.send(["action": "previous"])
                printElement(r)
            case "f", "first":
                let r = try bridge.send(["action": "first"])
                printElement(r)
            case "l", "last":
                let r = try bridge.send(["action": "last"])
                printElement(r)
            case "a", "activate", "press":
                let r = try bridge.send(["action": "activate"])
                if r["ok"] != nil {
                    print("  \u{001B}[32m✓ Activated\u{001B}[0m")
                } else {
                    print("  \u{001B}[31m✗ \(r["error"] as? String ?? "Failed")\u{001B}[0m")
                }
            case "ls", "list":
                let r = try bridge.send(["action": "list"])
                printElementList(r)
            case "h", "help", "?":
                printHelp()
            case "q", "quit", "exit":
                _ = try? bridge.send(["action": "disconnect"])
                print("Disconnected.")
                return
            default:
                print("  Unknown command. Type 'h' for help.")
            }
        }
    }

    private func printHelp() {
        print(
            """

            \u{001B}[1mAccesstive Navigator\u{001B}[0m
            ─────────────────────────────────────
            n / next       Move to next element
            p / previous   Move to previous element
            f / first      Move to first element
            l / last       Move to last element
            a / activate   Tap the focused element
            ls / list      List visible elements
            h / help       Show this help
            q / quit       Disconnect and exit
            ─────────────────────────────────────
            """)
    }

    private func printElement(_ response: [String: Any]) {
        if let error = response["error"] as? String {
            print("  \u{001B}[31m✗ \(error)\u{001B}[0m")
            return
        }
        guard let element = response["element"] as? [String: Any] else {
            print("  \u{001B}[33m(no element)\u{001B}[0m")
            return
        }

        let caption = element["caption"] as? String ?? "(unknown)"
        let spoken = element["spoken_description"] as? String

        print("  \u{001B}[1m→ \(caption)\u{001B}[0m")
        if let spoken = spoken, spoken != caption {
            print("    \u{001B}[2mSpoken: \(spoken)\u{001B}[0m")
        }
    }

    private func printElementList(_ response: [String: Any]) {
        if let error = response["error"] as? String {
            print("  \u{001B}[31m✗ \(error)\u{001B}[0m")
            return
        }
        guard let elements = response["elements"] as? [[String: Any]] else {
            print("  \u{001B}[33m(no elements)\u{001B}[0m")
            return
        }

        let count = response["count"] as? Int ?? elements.count
        print("  \u{001B}[1m\(count) element(s):\u{001B}[0m")
        for (i, el) in elements.enumerated() {
            let caption = el["caption"] as? String ?? "(unknown)"
            print("  \(i + 1). \(caption)")
        }
    }
}

// MARK: - Bridge Process

/// Manages the Python bridge subprocess for pymobiledevice3 communication.
private final class BridgeProcess {
    let udid: String
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?

    init(udid: String) throws {
        self.udid = udid
    }

    func start() throws {
        let process = Process()
        let stdin = Pipe()
        let stdout = Pipe()

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", bridgeScriptPath()]
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        try process.run()

        self.process = process
        self.stdinPipe = stdin
        self.stdoutPipe = stdout

        // Wait for ready signal
        let ready = try readLine()
        guard let data = ready.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["ready"] as? Bool == true
        else {
            throw AccesstiveError.connectionFailed("Bridge failed to start")
        }
    }

    func send(_ command: [String: String]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: command)
        guard var text = String(data: data, encoding: .utf8) else {
            throw AccesstiveError.connectionFailed("Failed to encode command")
        }
        text += "\n"

        stdinPipe?.fileHandleForWriting.write(text.data(using: .utf8)!)

        let responseLine = try readLine()
        guard let responseData = responseLine.data(using: .utf8),
            let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        else {
            throw AccesstiveError.connectionFailed("Invalid response from bridge")
        }
        return json
    }

    private func readLine() throws -> String {
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
        return String(data: buffer, encoding: .utf8) ?? ""
    }

    func stop() {
        stdinPipe?.fileHandleForWriting.closeFile()
        process?.terminate()
        process = nil
    }

    private func bridgeScriptPath() -> String {
        // Look for the script relative to the executable, then fall back to known location
        let execURL = URL(fileURLWithPath: CommandLine.arguments[0])
        let scriptDir = execURL.deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Scripts")
            .appendingPathComponent("accesstive-bridge.py")

        if FileManager.default.fileExists(atPath: scriptDir.path) {
            return scriptDir.path
        }

        // Check common development locations
        let candidates = [
            "\(FileManager.default.currentDirectoryPath)/Scripts/accesstive-bridge.py",
            "\(NSHomeDirectory())/accesstive/Scripts/accesstive-bridge.py",
        ]
        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }

        return "Scripts/accesstive-bridge.py"
    }
}
