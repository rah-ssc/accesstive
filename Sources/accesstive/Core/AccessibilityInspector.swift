import AppKit
@preconcurrency import ApplicationServices
import Foundation

/// Inspects the accessibility tree of iOS Simulator apps via the macOS AXUIElement API.
///
/// The iOS Simulator runs as a Mac process, so its accessibility tree is exposed
/// through the standard macOS Accessibility framework (AXUIElement). This inspector
/// locates the Simulator process, drills into the hosted iOS app surface, and
/// captures the full element tree.
struct AccessibilityInspector: Sendable {
    let session: DeviceConnector.Session

    /// Capture the accessibility tree.
    /// Routes to AXUIElement (simulator) or pymobiledevice3 (physical device).
    func captureTree(bundleId: String? = nil, maxDepth: Int = Int.max) async throws
        -> AccessibilityNode
    {
        if session.device.isSimulator {
            return try captureSimulatorTree(bundleId: bundleId, maxDepth: maxDepth)
        } else {
            return try await capturePhysicalDeviceTree(maxDepth: maxDepth)
        }
    }

    // MARK: - Simulator (AXUIElement)

    private func captureSimulatorTree(bundleId: String?, maxDepth: Int) throws
        -> AccessibilityNode
    {
        try checkAccessibilityPermissions()

        let simulatorPID = try findSimulatorPID()
        let appElement = AXUIElementCreateApplication(simulatorPID)
        let rootElement = try findAppContent(in: appElement, bundleId: bundleId)

        return buildTree(from: rootElement, depth: 0, maxDepth: maxDepth)
    }

    // MARK: - Permissions

    private func checkAccessibilityPermissions() throws {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        if !trusted {
            throw AccesstiveError.accessibilityNotEnabled
        }
    }

    // MARK: - Simulator Process Discovery

    private func findSimulatorPID() throws -> pid_t {
        let workspace = NSWorkspace.shared
        let apps = workspace.runningApplications

        // Look for the Simulator app
        if let simulator = apps.first(where: {
            $0.bundleIdentifier == "com.apple.iphonesimulator"
        }) {
            return simulator.processIdentifier
        }

        throw AccesstiveError.simulatorNotBooted
    }

    // MARK: - AX Tree Navigation

    private func findAppContent(
        in element: AXUIElement,
        bundleId: String?
    ) throws -> AXUIElement {
        // For now, return the root element.
        // A full implementation would walk the tree to find the specific
        // iOS app content area within the Simulator window.
        // The Simulator hierarchy is:
        //   AXApplication → AXWindow → AXGroup (device bezel) → AXWebArea / AXGroup (app content)
        return element
    }

    // MARK: - Tree Building

    private func buildTree(
        from element: AXUIElement,
        depth: Int,
        maxDepth: Int
    ) -> AccessibilityNode {
        let role = axValue(of: element, attribute: kAXRoleAttribute) ?? "Unknown"
        let label =
            axValue(of: element, attribute: kAXDescriptionAttribute)
            ?? axValue(of: element, attribute: kAXTitleAttribute)
        let value = axValue(of: element, attribute: kAXValueAttribute)
        let hint = axValue(of: element, attribute: kAXHelpAttribute)
        let identifier = axValue(of: element, attribute: kAXIdentifierAttribute)
        let enabled = axBoolValue(of: element, attribute: kAXEnabledAttribute)
        let frame = axFrameValue(of: element)

        var children: [AccessibilityNode] = []

        if depth < maxDepth {
            var childrenRef: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(
                element, kAXChildrenAttribute as CFString, &childrenRef)

            if result == .success, let axChildren = childrenRef as? [AXUIElement] {
                children = axChildren.map { child in
                    buildTree(from: child, depth: depth + 1, maxDepth: maxDepth)
                }
            }
        }

        return AccessibilityNode(
            role: role,
            label: label,
            value: value,
            hint: hint,
            traits: [],
            frame: frame,
            identifier: identifier,
            isEnabled: enabled,
            children: children
        )
    }

    // MARK: - AXUIElement Helpers

    private func axValue(of element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let cfValue = value else { return nil }
        return "\(cfValue)"
    }

    private func axBoolValue(of element: AXUIElement, attribute: String) -> Bool {
        guard let str = axValue(of: element, attribute: attribute) else { return true }
        return str == "1" || str.lowercased() == "true"
    }

    private func axFrameValue(of element: AXUIElement) -> CGRect {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?

        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue)
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

        var position = CGPoint.zero
        var size = CGSize.zero

        if let posValue = posValue {
            AXValueGetValue(posValue as! AXValue, .cgPoint, &position)
        }
        if let sizeValue = sizeValue {
            AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        }

        return CGRect(origin: position, size: size)
    }

    // MARK: - Physical Device (pymobiledevice3)

    private func capturePhysicalDeviceTree(maxDepth: Int) async throws -> AccessibilityNode {
        let udid = session.device.udid
        let output = try await DeviceConnector.shellArray([
            "pymobiledevice3", "developer", "accessibility", "list-items",
            "--udid", udid,
        ])

        guard let data = output.data(using: .utf8),
            let items = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            throw AccesstiveError.connectionFailed("Failed to parse accessibility data from device")
        }

        let children = items.map { item -> AccessibilityNode in
            let caption = item["caption"] as? String ?? ""
            let spokenDesc = item["spoken_description"] as? String

            // Parse role and label from caption (format: "Label, Role" or "Label, Value, Role")
            let parts = caption.components(separatedBy: ", ")
            let role: String
            let label: String?
            let value: String?
            let isEnabled: Bool

            if parts.count >= 2 {
                label = parts[0]
                role = parts.last ?? "Unknown"
                value = parts.count > 2 ? parts[1..<parts.count - 1].joined(separator: ", ") : nil
            } else {
                label = caption.isEmpty ? nil : caption
                role = "Unknown"
                value = nil
            }

            // Check for "Not Enabled" in caption
            isEnabled = !caption.contains("Not Enabled")

            return AccessibilityNode(
                role: role,
                label: label,
                value: value,
                hint: spokenDesc != caption ? spokenDesc : nil,
                traits: [],
                frame: .zero,
                identifier: item["estimated_uid"] as? String,
                isEnabled: isEnabled,
                children: []
            )
        }

        return AccessibilityNode(
            role: "AXApplication",
            label: session.device.name,
            value: nil,
            hint: nil,
            traits: [],
            frame: .zero,
            identifier: session.device.udid,
            isEnabled: true,
            children: maxDepth > 0 ? children : []
        )
    }
}
