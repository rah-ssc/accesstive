import Foundation

/// Formats audit issues for display.
struct AuditReporter: Sendable {
    let format: OutputFormat

    func report(issues: [AuditIssue]) -> String {
        switch format {
        case .json:
            return reportJSON(issues: issues)
        case .junit:
            return reportJUnit(issues: issues)
        default:
            return reportText(issues: issues)
        }
    }

    // MARK: - Text Format

    private func reportText(issues: [AuditIssue]) -> String {
        if issues.isEmpty {
            return "✅ No accessibility issues found."
        }

        var lines: [String] = []
        lines.append("Accessibility Audit Results")
        lines.append(String(repeating: "=", count: 40))
        lines.append("Found \(issues.count) issue(s):\n")

        let sorted = issues.sorted { $0.severity.rank > $1.severity.rank }

        for (index, issue) in sorted.enumerated() {
            lines.append(
                "\(index + 1). \(issue.severity.symbol) [\(issue.severity.rawValue.uppercased())] \(issue.ruleName)"
            )
            lines.append("   Rule: \(issue.ruleId)")
            lines.append(
                "   Element: [\(issue.element.role)] \(issue.element.label ?? "(no label)")")
            lines.append("   \(issue.message)")
            if let suggestion = issue.suggestion {
                lines.append("   Suggestion: \(suggestion)")
            }
            lines.append("")
        }

        let errors = issues.filter { $0.severity == .error }.count
        let warnings = issues.filter { $0.severity == .warning }.count
        let hints = issues.filter { $0.severity == .hint }.count
        lines.append("Summary: \(errors) error(s), \(warnings) warning(s), \(hints) hint(s)")

        return lines.joined(separator: "\n")
    }

    // MARK: - JSON Format

    private func reportJSON(issues: [AuditIssue]) -> String {
        let dicts: [[String: Any]] = issues.map { issue in
            var dict: [String: Any] = [
                "ruleId": issue.ruleId,
                "ruleName": issue.ruleName,
                "severity": issue.severity.rawValue,
                "message": issue.message,
                "element": [
                    "role": issue.element.role,
                    "label": issue.element.label ?? "",
                ],
            ]
            if let suggestion = issue.suggestion {
                dict["suggestion"] = suggestion
            }
            return dict
        }

        guard
            let data = try? JSONSerialization.data(
                withJSONObject: ["issues": dicts, "count": issues.count],
                options: [.prettyPrinted, .sortedKeys]
            ),
            let json = String(data: data, encoding: .utf8)
        else {
            return "[]"
        }
        return json
    }

    // MARK: - JUnit XML Format (for CI integration)

    private func reportJUnit(issues: [AuditIssue]) -> String {
        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        xml += "<testsuites>\n"
        xml +=
            "  <testsuite name=\"accesstive\" tests=\"\(issues.count)\" failures=\"\(issues.count)\">\n"

        for issue in issues {
            let name = xmlEscape(issue.ruleName)
            let message = xmlEscape(issue.message)
            xml += "    <testcase name=\"\(name)\" classname=\"\(issue.ruleId)\">\n"
            xml += "      <failure message=\"\(message)\" type=\"\(issue.severity.rawValue)\">\n"
            xml +=
                "Element: [\(xmlEscape(issue.element.role))] \(xmlEscape(issue.element.label ?? "(no label)"))\n"
            if let suggestion = issue.suggestion {
                xml += "Suggestion: \(xmlEscape(suggestion))\n"
            }
            xml += "      </failure>\n"
            xml += "    </testcase>\n"
        }

        xml += "  </testsuite>\n"
        xml += "</testsuites>"
        return xml
    }

    private func xmlEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}
