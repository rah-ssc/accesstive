import Foundation

/// Formats an accessibility tree for display.
struct OutputFormatter: Sendable {
    let format: OutputFormat
    let includeFrames: Bool

    func format(tree: AccessibilityNode) -> String {
        switch format {
        case .tree:
            return formatTree(node: tree, indent: 0)
        case .json:
            return formatJSON(node: tree)
        case .flat:
            return formatFlat(node: tree)
        case .text:
            return formatTree(node: tree, indent: 0)
        case .junit:
            return formatTree(node: tree, indent: 0)
        }
    }

    // MARK: - Tree Format

    private func formatTree(node: AccessibilityNode, indent: Int) -> String {
        var lines: [String] = []
        let prefix = String(repeating: "  ", count: indent)
        let connector = indent == 0 ? "" : "├─ "

        var line = "\(prefix)\(connector)[\(node.role)]"

        if let label = node.label {
            line += " \"\(label)\""
        }
        if let value = node.value {
            line += " = \"\(value)\""
        }
        if let identifier = node.identifier {
            line += " (#\(identifier))"
        }
        if !node.isEnabled {
            line += " [disabled]"
        }
        if includeFrames {
            line +=
                " {\(Int(node.frame.origin.x)),\(Int(node.frame.origin.y)) \(Int(node.frame.width))x\(Int(node.frame.height))}"
        }

        lines.append(line)

        for child in node.children {
            lines.append(formatTree(node: child, indent: indent + 1))
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - JSON Format

    private func formatJSON(node: AccessibilityNode) -> String {
        let dict = nodeToDict(node: node)
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
            let json = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return json
    }

    private func nodeToDict(node: AccessibilityNode) -> [String: Any] {
        var dict: [String: Any] = ["role": node.role]

        if let label = node.label { dict["label"] = label }
        if let value = node.value { dict["value"] = value }
        if let hint = node.hint { dict["hint"] = hint }
        if let identifier = node.identifier { dict["identifier"] = identifier }
        if !node.traits.isEmpty { dict["traits"] = node.traits }
        dict["enabled"] = node.isEnabled

        if includeFrames {
            dict["frame"] = [
                "x": node.frame.origin.x,
                "y": node.frame.origin.y,
                "width": node.frame.width,
                "height": node.frame.height,
            ]
        }

        if !node.children.isEmpty {
            dict["children"] = node.children.map { nodeToDict(node: $0) }
        }

        return dict
    }

    // MARK: - Flat Format

    private func formatFlat(node: AccessibilityNode) -> String {
        var lines: [String] = []
        flattenNode(node: node, path: "", lines: &lines)
        return lines.joined(separator: "\n")
    }

    private func flattenNode(node: AccessibilityNode, path: String, lines: inout [String]) {
        let currentPath = path.isEmpty ? node.role : "\(path) > \(node.role)"
        var line = currentPath

        if let label = node.label { line += " | label: \"\(label)\"" }
        if let value = node.value { line += " | value: \"\(value)\"" }

        lines.append(line)

        for child in node.children {
            flattenNode(node: child, path: currentPath, lines: &lines)
        }
    }
}
