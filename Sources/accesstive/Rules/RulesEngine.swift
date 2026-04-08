import Foundation

/// A rule that checks for a specific accessibility issue.
protocol AccessibilityRule: Sendable {
    var id: String { get }
    var name: String { get }
    var severity: Severity { get }

    func evaluate(node: AccessibilityNode) -> [AuditIssue]
}

/// Runs all enabled rules against an accessibility tree.
struct RulesEngine: Sendable {
    let rules: [any AccessibilityRule]
    let minSeverity: Severity

    init(enabledRuleIds: [String]? = nil, minSeverity: Severity = .warning) {
        let allRules: [any AccessibilityRule] = [
            MissingLabelRule(),
            MissingHintRule(),
            SmallTouchTargetRule(),
            DisabledWithoutContextRule(),
            ImageMissingDescriptionRule(),
            EmptyButtonRule(),
            RedundantTraitRule(),
        ]

        if let ids = enabledRuleIds {
            self.rules = allRules.filter { ids.contains($0.id) }
        } else {
            self.rules = allRules
        }

        self.minSeverity = minSeverity
    }

    /// Evaluate all rules against every node in the tree.
    func evaluate(tree: AccessibilityNode) -> [AuditIssue] {
        var issues: [AuditIssue] = []
        evaluateNode(tree, issues: &issues)
        return issues.filter { $0.severity.rank >= minSeverity.rank }
    }

    private func evaluateNode(_ node: AccessibilityNode, issues: inout [AuditIssue]) {
        for rule in rules {
            issues.append(contentsOf: rule.evaluate(node: node))
        }
        for child in node.children {
            evaluateNode(child, issues: &issues)
        }
    }
}
