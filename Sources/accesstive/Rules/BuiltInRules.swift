import Foundation

// MARK: - AX-001: Missing Label

/// Interactive elements must have an accessibility label.
struct MissingLabelRule: AccessibilityRule {
    let id = "AX-001"
    let name = "Missing Accessibility Label"
    let severity = Severity.error

    private let interactiveRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXSlider",
        "AXSwitch", "AXLink", "AXPopUpButton", "AXComboBox",
        "AXCheckBox", "AXRadioButton", "AXSegmentedControl",
        "AXStepper", "AXPicker",
    ]

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard interactiveRoles.contains(node.role), !node.hasLabel else {
            return []
        }
        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message: "Interactive element [\(node.role)] has no accessibility label.",
                element: node,
                suggestion: "Add an accessibilityLabel to describe this element's purpose."
            )
        ]
    }
}

// MARK: - AX-002: Missing Hint

/// Complex interactive elements should have a hint describing their action.
struct MissingHintRule: AccessibilityRule {
    let id = "AX-002"
    let name = "Missing Accessibility Hint"
    let severity = Severity.hint

    private let hintRoles: Set<String> = [
        "AXButton", "AXLink", "AXSwitch", "AXSlider",
    ]

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard hintRoles.contains(node.role), node.hasLabel, !node.hasHint else {
            return []
        }
        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message: "[\(node.role)] \"\(node.label ?? "")\" has no accessibility hint.",
                element: node,
                suggestion:
                    "Add an accessibilityHint describing what happens when you interact with this element."
            )
        ]
    }
}

// MARK: - AX-003: Small Touch Target

/// Interactive elements should meet the minimum 44x44 pt touch target size.
struct SmallTouchTargetRule: AccessibilityRule {
    let id = "AX-003"
    let name = "Touch Target Too Small"
    let severity = Severity.warning

    private let minimumSize: CGFloat = 44.0

    private let interactiveRoles: Set<String> = [
        "AXButton", "AXLink", "AXSwitch", "AXSlider",
        "AXCheckBox", "AXRadioButton", "AXStepper",
    ]

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard interactiveRoles.contains(node.role) else { return [] }

        let tooSmall = node.frame.width < minimumSize || node.frame.height < minimumSize
        let hasSize = node.frame.width > 0 && node.frame.height > 0

        guard hasSize, tooSmall else { return [] }

        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message:
                    "[\(node.role)] \"\(node.label ?? "")\" has size \(Int(node.frame.width))x\(Int(node.frame.height)) pt, below the 44x44 pt minimum.",
                element: node,
                suggestion:
                    "Increase the tappable area to at least 44x44 points for better accessibility."
            )
        ]
    }
}

// MARK: - AX-004: Disabled Without Context

/// Disabled elements should explain why they are disabled.
struct DisabledWithoutContextRule: AccessibilityRule {
    let id = "AX-004"
    let name = "Disabled Element Without Context"
    let severity = Severity.warning

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard !node.isEnabled, !node.hasHint else { return [] }

        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message:
                    "[\(node.role)] \"\(node.label ?? "")\" is disabled but has no hint explaining why.",
                element: node,
                suggestion:
                    "Add an accessibilityHint that explains why this element is disabled and how to enable it."
            )
        ]
    }
}

// MARK: - AX-005: Image Missing Description

/// Images should have an accessibility label or be marked as decorative.
struct ImageMissingDescriptionRule: AccessibilityRule {
    let id = "AX-005"
    let name = "Image Missing Description"
    let severity = Severity.error

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard node.role == "AXImage", !node.hasLabel else { return [] }

        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message: "Image element has no accessibility label.",
                element: node,
                suggestion:
                    "Add an accessibilityLabel describing the image, or mark it as decorative with .accessibilityHidden(true)."
            )
        ]
    }
}

// MARK: - AX-006: Empty Button

/// Buttons must have some form of accessible text content.
struct EmptyButtonRule: AccessibilityRule {
    let id = "AX-006"
    let name = "Empty Button"
    let severity = Severity.error

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard node.role == "AXButton",
            !node.hasLabel,
            node.value == nil || node.value!.isEmpty
        else { return [] }

        return [
            AuditIssue(
                ruleId: id,
                ruleName: name,
                severity: severity,
                message: "Button has no label or accessible text content.",
                element: node,
                suggestion:
                    "Add an accessibilityLabel to the button, or ensure it contains accessible text."
            )
        ]
    }
}

// MARK: - AX-007: Redundant Trait

/// Elements labelled with their trait are redundant (e.g., "Settings Button" on a Button).
struct RedundantTraitRule: AccessibilityRule {
    let id = "AX-007"
    let name = "Redundant Trait in Label"
    let severity = Severity.hint

    private let roleWords: [String: [String]] = [
        "AXButton": ["button", "btn"],
        "AXImage": ["image", "icon", "img"],
        "AXLink": ["link"],
        "AXTextField": ["text field", "textfield", "input"],
    ]

    func evaluate(node: AccessibilityNode) -> [AuditIssue] {
        guard let label = node.label?.lowercased(),
            let words = roleWords[node.role]
        else { return [] }

        for word in words {
            if label.hasSuffix(word) || label.hasPrefix(word) {
                return [
                    AuditIssue(
                        ruleId: id,
                        ruleName: name,
                        severity: severity,
                        message:
                            "[\(node.role)] label \"\(node.label!)\" contains the redundant word \"\(word)\". VoiceOver already announces the element type.",
                        element: node,
                        suggestion:
                            "Remove \"\(word)\" from the label. VoiceOver automatically announces the element's role."
                    )
                ]
            }
        }
        return []
    }
}
