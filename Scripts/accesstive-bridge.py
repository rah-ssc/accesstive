#!/usr/bin/env python3
"""
accesstive-bridge: Bridge between accesstive CLI and pymobiledevice3 for
interactive accessibility navigation on physical iOS devices.

Protocol: Reads JSON commands from stdin, writes JSON responses to stdout.
One command per line, one response per line.

Commands:
  {"action": "connect", "udid": "..."}
  {"action": "next"}
  {"action": "previous"}
  {"action": "first"}
  {"action": "last"}
  {"action": "activate"}
  {"action": "list"}
  {"action": "disconnect"}
"""

import asyncio
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.accessibilityaudit import (
    AccessibilityAudit,
    Direction,
)
from pymobiledevice3.services.accessibilityaudit import deserialize_object


class AccessibilityBridge:
    def __init__(self):
        self.service = None
        self.lockdown = None
        self.udid = None
        self.current_element = None
        self.current_element_bytes = None
        self.current_screen_name = None
        self.current_actions = []
        self._monitoring_ready = False
        self._announcement_monitor_task = None
        self._announcement_monitor_running = False
        self._last_announcement_signature = None
        self._announcement_recent_signatures = {}
        self.wda_xctrunner_candidates = [
            "com.facebook.WebDriverAgentRunner.xctrunner",
            "com.pcloudywda.WebDriverAgentRunner.xctrunner",
        ]

    def _classify_announcement_type(self, event_name, text):
        value = f"{event_name or ''} {text or ''}".lower()
        if "focus" in value or "currentelementchanged" in value:
            return "focus_change"
        if "alert" in value:
            return "alert"
        if "screen changed" in value or "layout changed" in value or ("screen" in value and "changed" in value):
            return "screen_change"
        return "dynamic_update"

    def _find_first_text(self, value):
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            preferred_keys = [
                "announcement",
                "Announcement",
                "message",
                "Message",
                "caption",
                "spoken_description",
                "label",
                "value",
            ]
            for key in preferred_keys:
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()

            for candidate in value.values():
                found = self._find_first_text(candidate)
                if found:
                    return found
            return ""

        if isinstance(value, (list, tuple)):
            for item in value:
                found = self._find_first_text(item)
                if found:
                    return found
            return ""

        return ""

    def _build_announcement_event(self, event):
        payload = self._jsonify(getattr(event, "data", None))
        event_name = str(getattr(event, "name", "") or "")
        text = self._find_first_text(payload) or event_name

        if not text:
            return None

        merged = f"{event_name} {text}".lower()
        keywords = [
            "announcement",
            "voiceover",
            "accessibility",
            "screen",
            "layout",
            "alert",
            "notification",
            "focus",
            "selected",
            "activated",
            "current",
        ]
        accessibility_event_names = [
            "hostinspectorcurrentelementchanged",
            "announcement",
            "screen",
            "layout",
            "focus",
            "notification",
        ]
        event_name_l = event_name.lower()

        if not any(token in merged for token in keywords) and not any(
            token in event_name_l for token in accessibility_event_names
        ):
            return None

        event_type = self._classify_announcement_type(event_name, text)
        screen = self._extract_screen_name(payload) or self.current_screen_name or ""
        element = self._extract_element_reference(payload, fallback_text=text)
        if not element.get("label"):
            element["label"] = text

        announcement = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "event_type": event_type,
            "text": text,
            "screen": screen,
            "element": element,
            "source": "voiceover",
            "raw_event_name": event_name,
        }

        return announcement if self._should_emit_announcement(announcement) else None

    def _build_focus_announcement_event(self, focus_item, event_name):
        if focus_item is None:
            return None

        label = (
            getattr(focus_item, "spoken_description", None)
            or getattr(focus_item, "caption", None)
            or ""
        )
        label = str(label).strip()
        if not label:
            return None

        announcement = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": "focus_change",
            "event_type": "focus_change",
            "text": label,
            "screen": self._extract_screen_name(focus_item) or self.current_screen_name or "",
            "element": self._build_element_reference(focus_item, label),
            "source": "voiceover",
            "raw_event_name": str(event_name or "hostInspectorCurrentElementChanged:"),
        }

        signature = self._announcement_signature(announcement)
        if signature == self._last_announcement_signature:
            return None
        self._last_announcement_signature = signature

        return announcement if self._should_emit_announcement(announcement) else None

    def _activation_help_hint(self):
        """Return platform-specific guidance for activation fallbacks."""
        product_version = getattr(self.lockdown, "product_version", "") or ""
        major = 0
        try:
            major = int(str(product_version).split(".", 1)[0])
        except Exception:
            major = 0

        if major >= 17:
            return (
                "For iOS 17+, start a tunnel in another terminal: "
                "sudo pymobiledevice3 remote start-tunnel --udid "
                f"{self.udid} --script-mode"
            )

        return (
            "For iOS 16 and below, mount DeveloperDiskImage first (WDA needs it): "
            "sudo pymobiledevice3 mounter auto-mount --udid "
            f"{self.udid}"
        )

    @staticmethod
    def _wrap_passthrough(value):
        return {"ObjectType": "passthrough", "Value": value}

    def _extract_actions(self, focus_item):
        """Extract available action attributes from the focused element metadata."""
        actions = []
        fields = getattr(focus_item, "_fields", {}) if focus_item is not None else {}
        sections = fields.get("InspectorSectionsValue_v1") or []

        for section in sections:
            section_fields = getattr(section, "_fields", {})
            section_id = section_fields.get("IdentifierValue_v1")
            section_title = section_fields.get("TitleValue_v1")
            if section_id != "iOS_Actions_v1" and section_title != "Actions":
                continue

            for attr in section_fields.get("ElementAttributesValue_v1") or []:
                attr_fields = getattr(attr, "_fields", {})
                if not attr_fields:
                    continue
                actions.append(attr_fields)

        return actions

    def _build_action_payload(self, action_fields):
        """Build DTX payload for a specific AX action attribute."""
        return {
            "ObjectType": "AXAuditElementAttribute_v1",
            "Value": {
                "ObjectType": "passthrough",
                "Value": {
                    key: self._wrap_passthrough(value)
                    for key, value in action_fields.items()
                },
            },
        }

    def _compact_wda_error(self, raw_error):
        """Reduce noisy WDA stderr output to a short, user-facing summary."""
        text = (raw_error or "").strip()
        if not text:
            return "WDA tap failed"

        lowered = text.lower()

        if "appnotinstallederror" in lowered:
            if "com.facebook.webdriveragentrunner.xctrunner" in lowered:
                return "WDA runner not installed (com.facebook.WebDriverAgentRunner.xctrunner)"
            if "com.pcloudywda.webdriveragentrunner.xctrunner" in lowered:
                return "WDA runner not installed (com.pcloudywda.WebDriverAgentRunner.xctrunner)"
            return "WDA runner app is not installed on the device"

        if "no app with bundle id" in lowered:
            return "WDA runner app is not installed on the device"

        # If traceback is present, keep only the final exception line.
        cleaned_lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not cleaned_lines:
            return "WDA tap failed"

        for line in reversed(cleaned_lines):
            if "error" in line.lower() or "exception" in line.lower():
                return line

        return cleaned_lines[-1]

    def _run_wda_tap(self, selector, using, xctrunner=None):
        """Try WDA tap by selector. Returns None on success or error text on failure."""
        if not self.udid:
            return "No device UDID available for WDA tap"

        cmd = [
            sys.executable,
            "-m",
            "pymobiledevice3",
            "developer",
            "wda",
            "tap",
            "--udid",
            self.udid,
            "--using",
            using,
            "--timeout",
            "6",
        ]

        if xctrunner:
            cmd.extend(["--xctrunner", xctrunner])

        cmd.append(selector)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=12,
                check=False,
            )
        except Exception as e:
            return str(e)

        stderr_text = (result.stderr or "").strip()
        stdout_text = (result.stdout or "").strip()
        combined = f"{stdout_text}\n{stderr_text}".strip().lower()

        # pymobiledevice3 wda commands may emit an error on stderr with return code 0.
        if result.returncode == 0 and "error" not in combined and "failed" not in combined:
            return None

        return self._compact_wda_error(stderr_text or stdout_text or "WDA tap failed")

    def _attempt_wda_tap_fallback(self):
        """Fallback tap using WebDriverAgent selectors based on focused caption."""
        caption = (getattr(self.current_element, "caption", None) or "").strip()
        if not caption:
            return False, "No focused caption available for WDA tap fallback"

        candidates = [caption]
        primary = caption.split(",", 1)[0].strip()
        if primary and primary not in candidates:
            candidates.append(primary)

        strategies = ["name", "label", "accessibility id"]
        xctrunner_candidates = [None] + self.wda_xctrunner_candidates
        errors = []

        for sel in candidates:
            for using in strategies:
                for xctrunner in xctrunner_candidates:
                    err = self._run_wda_tap(sel, using, xctrunner=xctrunner)
                    if err is None:
                        if xctrunner:
                            return True, f"WDA tap succeeded via {using}: {sel} (runner: {xctrunner})"
                        return True, f"WDA tap succeeded via {using}: {sel}"

                    if xctrunner:
                        errors.append(f"{using}:{sel}:{xctrunner}: {err}")
                    else:
                        errors.append(f"{using}:{sel}: {err}")

        return False, (errors[-1] if errors else "Unknown WDA error")

    def _cache_focus_item(self, current_item):
        """Store the latest focused item and its element identifier bytes."""
        self.current_element = current_item
        element_obj = getattr(current_item, "element", None)
        self.current_element_bytes = (
            element_obj.identifier if element_obj is not None else None
        )
        self.current_screen_name = self._extract_screen_name(current_item)
        self.current_actions = self._extract_actions(current_item)

    def _jsonify(self, value):
        """Convert bridge values to JSON-safe values without failing the stream."""
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, bytes):
            return value.hex()
        if isinstance(value, (list, tuple)):
            return [self._jsonify(item) for item in value]
        if isinstance(value, dict):
            return {str(k): self._jsonify(v) for k, v in value.items()}
        if hasattr(value, "_fields"):
            return {
                str(k): self._jsonify(v)
                for k, v in getattr(value, "_fields", {}).items()
            }
        return str(value)

    def _extract_traits(self, focus_item):
        """Best-effort extraction of element traits from focus item metadata."""
        fields = getattr(focus_item, "_fields", {}) if focus_item is not None else {}
        trait_candidates = []

        for key, value in fields.items():
            key_lower = str(key).lower()
            if "trait" in key_lower:
                trait_candidates.append(value)

        if not trait_candidates:
            return []

        flattened = []
        for candidate in trait_candidates:
            normalized = self._jsonify(candidate)
            if isinstance(normalized, list):
                flattened.extend([str(item) for item in normalized if item is not None])
            elif normalized is not None:
                flattened.append(str(normalized))

        # Preserve order while deduplicating.
        deduped = []
        seen = set()
        for item in flattened:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)
        return deduped

    def _extract_bounds(self, focus_item):
        """Best-effort extraction of x/y/width/height from focus metadata."""
        fields = getattr(focus_item, "_fields", {}) if focus_item is not None else {}

        rect_value = None
        for key, value in fields.items():
            key_lower = str(key).lower()
            if "rect" in key_lower or "frame" in key_lower or "bounds" in key_lower:
                rect_value = value
                break

        if rect_value is None:
            return None

        normalized = self._jsonify(rect_value)

        if isinstance(normalized, dict):
            x = normalized.get("x")
            y = normalized.get("y")
            width = normalized.get("width")
            height = normalized.get("height")

            # Handle nested "origin"/"size" style payloads.
            if x is None and isinstance(normalized.get("origin"), dict):
                x = normalized["origin"].get("x")
                y = normalized["origin"].get("y")
            if width is None and isinstance(normalized.get("size"), dict):
                width = normalized["size"].get("width")
                height = normalized["size"].get("height")

            if None not in (x, y, width, height):
                try:
                    return {
                        "x": float(x),
                        "y": float(y),
                        "width": float(width),
                        "height": float(height),
                    }
                except (TypeError, ValueError):
                    return None

        if isinstance(normalized, list) and len(normalized) >= 4:
            try:
                return {
                    "x": float(normalized[0]),
                    "y": float(normalized[1]),
                    "width": float(normalized[2]),
                    "height": float(normalized[3]),
                }
            except (TypeError, ValueError):
                return None

        return None

    def _build_focus_event(self, element):
        """Build a structured focus event payload for streaming clients."""
        if element is None:
            return None

        label = getattr(element, "caption", None) or getattr(element, "spoken_description", None) or ""
        element_ref = self._build_element_reference(element, label)
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "label": str(label),
            "type": "focus_change",
            "event_type": "focus_change",
            "text": str(label),
            "screen": self._extract_screen_name(element) or "",
            "element": element_ref,
            "source": "voiceover",
            "traits": self._extract_traits(element),
            "bounds": self._extract_bounds(element),
        }

    async def connect(self, udid):
        self.lockdown = await create_using_usbmux(serial=udid)
        self.service = AccessibilityAudit(self.lockdown)
        self.udid = udid
        # Enable event monitoring so we can read focused element after move_focus
        await self.service._ensure_ready()
        await self.service.set_app_monitoring_enabled(True)
        await self.service.set_monitored_event_type()
        self._monitoring_ready = True
        return {"ok": True, "device": udid}

    async def move(self, direction):
        if not self.service:
            return {"error": "Not connected"}

        direction_map = {
            "next": Direction.Next,
            "previous": Direction.Previous,
            "first": Direction.First,
            "last": Direction.Last,
        }

        d = direction_map.get(direction)
        if d is None:
            return {"error": f"Unknown direction: {direction}"}

        # Drop stale events so we read the element change triggered by this move.
        self._drain_event_queue()
        await self.service.move_focus(d)

        # Read the focused element from the event queue (no extra move)
        return await self._read_focused_element()

    def _drain_event_queue(self):
        """Drain queued events without blocking to avoid consuming stale focus updates."""
        if not self.service:
            return

        queue = getattr(self.service, "_event_queue", None)
        if queue is None:
            return

        while True:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def _read_focused_element(self):
        """Read the hostInspectorCurrentElementChanged event to get the focused element."""
        try:
            consecutive_timeouts = 0
            while True:
                try:
                    name, args = await asyncio.wait_for(
                        self.service._event_queue.get(), timeout=2.0
                    )
                    consecutive_timeouts = 0
                except asyncio.TimeoutError:
                    consecutive_timeouts += 1
                    if consecutive_timeouts >= 3:
                        # Preserve last known focus when the event is delayed/missing.
                        if self.current_element is not None:
                            return self._format_element(self.current_element)
                        return {"ok": True, "element": None}
                    continue

                payload = self.service._extract_event_payload(args)
                if payload is None:
                    continue

                from pymobiledevice3.services.accessibilityaudit import Event
                event = Event(name=name, data=deserialize_object(payload))

                if event.name != "hostInspectorCurrentElementChanged:":
                    continue

                if isinstance(event.data, list):
                    if not event.data:
                        continue
                    current_item = event.data[0]
                else:
                    current_item = event.data

                self._cache_focus_item(current_item)
                result = self._format_element(current_item)
                result["focus_event"] = self._build_focus_event(current_item)
                return result
        except Exception as e:
            return {"error": str(e)}

    async def _sync_latest_focus_event(self, timeout=0.2):
        """Drain pending events briefly and cache the latest focused element if present."""
        if not self.service:
            return

        while True:
            try:
                name, args = await asyncio.wait_for(self.service._event_queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                return

            payload = self.service._extract_event_payload(args)
            if payload is None:
                continue

            from pymobiledevice3.services.accessibilityaudit import Event

            event = Event(name=name, data=deserialize_object(payload))
            if event.name != "hostInspectorCurrentElementChanged:":
                continue

            if isinstance(event.data, list):
                if not event.data:
                    continue
                current_item = event.data[0]
            else:
                current_item = event.data

            self._cache_focus_item(current_item)

    def _format_element(self, element):
        """Convert an AXAuditInspectorFocus_v1 to a JSON-serializable dict."""
        result = {}
        for attr in ["caption", "spoken_description", "estimated_uid", "platform_identifier"]:
            val = getattr(element, attr, None)
            if val is not None:
                if isinstance(val, bytes):
                    val = val.hex()
                result[attr] = str(val) if not isinstance(val, str) else val
        return {"ok": True, "element": result}

    def _normalize_role(self, raw_role, caption=""):
        value = str(raw_role or "").strip().lower()
        caption_value = str(caption or "").strip().lower()

        role_map = {
            "button": "AXButton",
            "btn": "AXButton",
            "link": "AXLink",
            "text field": "AXTextField",
            "textfield": "AXTextField",
            "text input": "AXTextField",
            "input": "AXTextField",
            "image": "AXImage",
            "icon": "AXImage",
            "switch": "AXSwitch",
            "slider": "AXSlider",
            "checkbox": "AXCheckBox",
            "radio button": "AXRadioButton",
            "stepper": "AXStepper",
            "picker": "AXPicker",
            "cell": "AXCell",
            "static text": "AXStaticText",
            "label": "AXStaticText",
            "text": "AXStaticText",
        }

        for key, role in role_map.items():
            if value == key or value.endswith(key) or key in value:
                return role

        if caption_value.endswith("button"):
            return "AXButton"
        if caption_value.endswith("link"):
            return "AXLink"
        if caption_value.endswith("text field") or caption_value.endswith("textfield"):
            return "AXTextField"
        if caption_value.endswith("image"):
            return "AXImage"

        return "Unknown"

    def _caption_parts(self, caption):
        text = str(caption or "").strip()
        if not text:
            return [], "", None

        parts = [part.strip() for part in text.split(",") if part.strip()]
        if len(parts) >= 3:
            role = self._normalize_role(parts[-1], caption=text)
            label = parts[0]
            value = ", ".join(parts[1:-1])
            return parts, label, {"role": role, "value": value}

        if len(parts) == 2:
            role = self._normalize_role(parts[-1], caption=text)
            label = parts[0]
            return parts, label, {"role": role, "value": None}

        return parts, parts[0], {"role": self._normalize_role(text, caption=text), "value": None}

    def _extract_role(self, element, caption=""):
        fields = getattr(element, "_fields", {}) if element is not None else {}
        candidates = []
        for key in [
            "role",
            "role_name",
            "roleDescription",
            "role_description",
            "AXRole",
            "AXRoleDescription",
            "type",
        ]:
            candidate = fields.get(key) if isinstance(fields, dict) else None
            if candidate:
                candidates.append(candidate)
            candidate = getattr(element, key, None)
            if candidate:
                candidates.append(candidate)

        for candidate in candidates:
            role = self._normalize_role(candidate, caption=caption)
            if role != "Unknown":
                return role

        _, _, parsed = self._caption_parts(caption)
        if parsed:
            return parsed["role"]

        return "Unknown"

    def _extract_label_value(self, element, caption=""):
        caption_text = str(caption or "").strip()
        _, parsed_label, parsed = self._caption_parts(caption_text)
        fields = getattr(element, "_fields", {}) if element is not None else {}

        label = ""
        value = None

        for key in ["caption", "spoken_description", "label", "text", "title", "name"]:
            candidate = None
            if isinstance(fields, dict):
                candidate = fields.get(key)
            if candidate is None:
                candidate = getattr(element, key, None)
            if isinstance(candidate, str) and candidate.strip():
                label = candidate.strip()
                break

        if not label:
            label = parsed_label or caption_text

        for key in ["value", "Value", "AXValue"]:
            candidate = None
            if isinstance(fields, dict):
                candidate = fields.get(key)
            if candidate is None:
                candidate = getattr(element, key, None)
            if candidate is None:
                continue
            if isinstance(candidate, bytes):
                candidate = candidate.hex()
            candidate_text = str(candidate).strip()
            if candidate_text:
                value = candidate_text
                break

        if value is None and parsed:
            value = parsed.get("value")

        return label, value

    def _extract_enabled_value(self, element, caption=""):
        fields = getattr(element, "_fields", {}) if element is not None else {}
        for key in ["enabled", "isEnabled", "AXEnabled"]:
            candidate = None
            if isinstance(fields, dict):
                candidate = fields.get(key)
            if candidate is None:
                candidate = getattr(element, key, None)
            if isinstance(candidate, bool):
                return candidate
            if isinstance(candidate, str):
                lowered = candidate.strip().lower()
                if lowered in {"1", "true", "yes", "enabled"}:
                    return True
                if lowered in {"0", "false", "no", "disabled"}:
                    return False

        return "not enabled" not in str(caption or "").lower()

    def _snapshot_visible_element(self, element):
        caption = str(getattr(element, "caption", None) or "").strip()
        spoken_description = str(getattr(element, "spoken_description", None) or "").strip()
        role = self._extract_role(element, caption=caption)
        label, value = self._extract_label_value(element, caption=caption)
        hint = spoken_description if spoken_description and spoken_description != caption else ""
        identifier = self._extract_element_reference(element, fallback_text=caption).get("id", "")
        return {
            "role": role,
            "label": label,
            "value": value,
            "hint": hint,
            "traits": self._extract_traits(element),
            "frame": self._extract_bounds(element) or {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0},
            "identifier": identifier,
            "isEnabled": self._extract_enabled_value(element, caption=caption),
            "children": [],
            "caption": caption,
            "spoken_description": spoken_description,
        }

    async def _snapshot_visible_elements(self, limit=120):
        if not self.service:
            return []

        elements = []
        async for item in self.service.iter_elements():
            elements.append(self._snapshot_visible_element(item))
            if len(elements) >= limit:
                break

        return elements

    def _issue_payload(self, rule_id, rule_name, severity, message, element, suggestion=None):
        issue = {
            "ruleId": rule_id,
            "ruleName": rule_name,
            "severity": severity,
            "message": message,
            "element": {
                "role": element.get("role", "Unknown"),
                "label": element.get("label", ""),
            },
        }
        if suggestion:
            issue["suggestion"] = suggestion
        return issue

    def _evaluate_scan_issues(self, node):
        issues = []
        interactive_roles = {
            "AXButton",
            "AXTextField",
            "AXTextArea",
            "AXSlider",
            "AXSwitch",
            "AXLink",
            "AXPopUpButton",
            "AXComboBox",
            "AXCheckBox",
            "AXRadioButton",
            "AXSegmentedControl",
            "AXStepper",
            "AXPicker",
            "AXCell",
        }

        hint_roles = {"AXButton", "AXLink", "AXSwitch", "AXSlider"}
        role_words = {
            "AXButton": ["button", "btn"],
            "AXImage": ["image", "icon", "img"],
            "AXLink": ["link"],
            "AXTextField": ["text field", "textfield", "input"],
        }

        def walk(item):
            role = item.get("role", "Unknown")
            label = item.get("label") or ""
            value = item.get("value") or ""
            hint = item.get("hint") or ""
            frame = item.get("frame") or {}
            enabled = item.get("isEnabled", True)

            if role in interactive_roles and not label:
                issues.append(
                    self._issue_payload(
                        "AX-001",
                        "Missing Accessibility Label",
                        "error",
                        f"Interactive element [{role}] has no accessibility label.",
                        item,
                        "Add an accessibilityLabel to describe this element's purpose.",
                    )
                )

            if role in hint_roles and label and not hint:
                issues.append(
                    self._issue_payload(
                        "AX-002",
                        "Missing Accessibility Hint",
                        "hint",
                        f"[{role}] \"{label}\" has no accessibility hint.",
                        item,
                        "Add an accessibilityHint describing what happens when you interact with this element.",
                    )
                )

            width = float(frame.get("width") or 0.0)
            height = float(frame.get("height") or 0.0)
            if role in {"AXButton", "AXLink", "AXSwitch", "AXSlider", "AXCheckBox", "AXRadioButton", "AXStepper"}:
                if width > 0 and height > 0 and (width < 44.0 or height < 44.0):
                    issues.append(
                        self._issue_payload(
                            "AX-003",
                            "Touch Target Too Small",
                            "warning",
                            f"[{role}] \"{label}\" has size {int(width)}x{int(height)} pt, below the 44x44 pt minimum.",
                            item,
                            "Increase the tappable area to at least 44x44 points for better accessibility.",
                        )
                    )

            if not enabled and not hint:
                issues.append(
                    self._issue_payload(
                        "AX-004",
                        "Disabled Element Without Context",
                        "warning",
                        f"[{role}] \"{label}\" is disabled but has no hint explaining why.",
                        item,
                        "Add an accessibilityHint that explains why this element is disabled and how to enable it.",
                    )
                )

            if role == "AXImage" and not label:
                issues.append(
                    self._issue_payload(
                        "AX-005",
                        "Image Missing Description",
                        "error",
                        "Image element has no accessibility label.",
                        item,
                        "Add an accessibilityLabel describing the image, or mark it as decorative with .accessibilityHidden(true).",
                    )
                )

            if role == "AXButton" and not label and not value:
                issues.append(
                    self._issue_payload(
                        "AX-006",
                        "Empty Button",
                        "error",
                        "Button has no label or accessible text content.",
                        item,
                        "Add an accessibilityLabel to the button, or ensure it contains accessible text.",
                    )
                )

            label_lower = str(label).lower()
            for role_name, words in role_words.items():
                if role == role_name:
                    for word in words:
                        if label_lower.startswith(word) or label_lower.endswith(word):
                            issues.append(
                                self._issue_payload(
                                    "AX-007",
                                    "Redundant Trait in Label",
                                    "hint",
                                    f"[{role}] label \"{label}\" contains the redundant word \"{word}\". VoiceOver already announces the element type.",
                                    item,
                                    f"Remove \"{word}\" from the label. VoiceOver automatically announces the element's role.",
                                )
                            )
                            break

            for child in item.get("children", []):
                walk(child)

        walk(node)
        return issues

    def _screen_signature(self, screen_name, elements):
        parts = [str(screen_name or "").strip().lower()]
        for element in elements[:8]:
            label = str(element.get("label") or "").strip().lower()
            role = str(element.get("role") or "").strip().lower()
            if label or role:
                parts.append(f"{role}:{label}")
        return "|".join(parts)

    def _screen_name_from_elements(self, elements, fallback=""):
        if self.current_screen_name:
            return self.current_screen_name
        for element in elements:
            label = str(element.get("label") or "").strip()
            if label:
                return label[:48]
        return fallback or "Screen"

    def _is_navigation_candidate(self, element):
        role = str(element.get("role") or "").strip()
        label = str(element.get("label") or "").strip().lower()
        if role not in {"AXButton", "AXLink", "AXCell", "AXStaticText"}:
            return False
        if not label:
            return False

        positive = [
            "login",
            "sign in",
            "sign up",
            "continue",
            "next",
            "proceed",
            "done",
            "submit",
            "checkout",
            "buy",
            "purchase",
            "place order",
            "open",
            "details",
            "start",
            "get started",
            "allow",
            "accept",
            "menu",
            "cart",
            "view",
            "more",
        ]
        negative = ["delete", "remove", "reset", "cancel", "close"]

        if any(token in label for token in negative):
            return False
        return any(token in label for token in positive)

    async def _capture_screen(self, bundle_id, max_elements=120):
        elements = await self._snapshot_visible_elements(limit=max_elements)
        screen_name = self._screen_name_from_elements(elements, fallback=bundle_id or "Screen")
        root = {
            "role": "AXApplication",
            "label": bundle_id or screen_name,
            "value": None,
            "hint": None,
            "traits": [],
            "frame": {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0},
            "identifier": bundle_id or "",
            "isEnabled": True,
            "children": elements,
        }
        issues = self._evaluate_scan_issues(root)
        severity_counts = {
            "error": sum(1 for issue in issues if issue["severity"] == "error"),
            "warning": sum(1 for issue in issues if issue["severity"] == "warning"),
            "hint": sum(1 for issue in issues if issue["severity"] == "hint"),
        }
        return {
            "name": screen_name,
            "signature": self._screen_signature(screen_name, elements),
            "elements": elements,
            "issues": issues,
            "count": len(issues),
            "severityCounts": severity_counts,
        }

    def _issue_signature(self, issue):
        element = issue.get("element") or {}
        return "|".join([
            str(issue.get("ruleId") or "").strip().lower(),
            str(issue.get("severity") or "").strip().lower(),
            re.sub(r"\s+", " ", str(issue.get("message") or "").strip().lower()),
            str(element.get("role") or "").strip().lower(),
            str(element.get("label") or "").strip().lower(),
        ])

    def _aggregate_flow(self, screens):
        flow_issues = []
        issue_groups = {}
        severity_groups = {"error": [], "warning": [], "hint": []}

        for screen in screens:
            for issue in screen["issues"]:
                enriched = dict(issue)
                enriched["screen"] = screen["name"]
                flow_issues.append(enriched)
                severity_groups.setdefault(enriched["severity"], []).append(enriched)

                signature = self._issue_signature(enriched)
                group = issue_groups.setdefault(
                    signature,
                    {
                        "ruleId": enriched.get("ruleId"),
                        "ruleName": enriched.get("ruleName"),
                        "severity": enriched.get("severity"),
                        "message": enriched.get("message"),
                        "element": enriched.get("element"),
                        "count": 0,
                        "screens": [],
                    },
                )
                group["count"] += 1
                if screen["name"] not in group["screens"]:
                    group["screens"].append(screen["name"])

        repeated_issues = [group for group in issue_groups.values() if group["count"] > 1]
        summary = {
            "screensScanned": len(screens),
            "totalIssues": len(flow_issues),
            "criticalIssues": len(severity_groups.get("error", [])),
            "severityGroups": {
                "error": len(severity_groups.get("error", [])),
                "warning": len(severity_groups.get("warning", [])),
                "hint": len(severity_groups.get("hint", [])),
            },
            "repeatedIssues": len(repeated_issues),
        }

        report_lines = [
            "App Scan Flow Report",
            f"Screens scanned: {summary['screensScanned']}",
            f"Total issues: {summary['totalIssues']}",
            f"Critical issues: {summary['criticalIssues']}",
        ]
        for screen in screens:
            report_lines.append(f"- {screen['name']}: {screen['count']} issue(s)")
        if repeated_issues:
            report_lines.append("Repeated issues:")
            for group in repeated_issues:
                report_lines.append(
                    f"- {group['ruleId']} x{group['count']} on {', '.join(group['screens'])}"
                )

        return {
            "issues": flow_issues,
            "severityGroups": severity_groups,
            "repeatedIssues": repeated_issues,
            "summary": summary,
            "report": "\n".join(report_lines),
        }

    def _detect_connected_device(self):
        try:
            result = subprocess.run(
                ["idevice_id", "-l"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                return ""
            for line in (result.stdout or "").splitlines():
                candidate = line.strip()
                if candidate:
                    return candidate
        except Exception:
            return ""
        return ""

    def _is_simulator_device(self, device_id):
        try:
            result = subprocess.run(
                ["xcrun", "simctl", "list", "devices", "-j"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0 or not result.stdout:
                return False

            payload = json.loads(result.stdout)
            devices = payload.get("devices", {})
            for runtime_devices in devices.values():
                for entry in runtime_devices:
                    if entry.get("udid") == device_id:
                        return True
        except Exception:
            return False

        return False

    def _run_swift_audit(self, device_id, bundle_id):
        repo_root = Path(__file__).resolve().parents[1]
        release_binary = repo_root / ".build" / "release" / "accesstive"

        commands = []
        if release_binary.exists():
            commands.append(
                [
                    str(release_binary),
                    "audit",
                    "--device",
                    device_id,
                    "--bundle-id",
                    bundle_id,
                    "--format",
                    "json",
                ]
            )

        commands.append(
            [
                "swift",
                "run",
                "accesstive",
                "audit",
                "--device",
                device_id,
                "--bundle-id",
                bundle_id,
                "--format",
                "json",
            ]
        )

        last_error = ""
        for command in commands:
            try:
                result = subprocess.run(
                    command,
                    cwd=str(repo_root),
                    capture_output=True,
                    text=True,
                    check=False,
                )
                stdout = (result.stdout or "").strip()
                stderr = (result.stderr or "").strip()
                if result.returncode == 0 and stdout:
                    try:
                        return json.loads(stdout)
                    except Exception:
                        last_error = "Failed to parse Swift audit output"
                        continue

                last_error = stderr or stdout or f"Swift audit failed with exit code {result.returncode}"
            except Exception as exc:
                last_error = str(exc)

        return {"error": last_error or "Swift audit failed"}

    def _launch_app_if_needed(self, bundle_id, device_id):
        try:
            result = subprocess.run(
                ["xcrun", "simctl", "list", "devices", "-j"],
                capture_output=True,
                text=True,
                check=False,
            )
            is_simulator = False
            if result.returncode == 0 and result.stdout:
                try:
                    payload = json.loads(result.stdout)
                    devices = payload.get("devices", {})
                    for runtime_devices in devices.values():
                        for entry in runtime_devices:
                            if entry.get("udid") == device_id:
                                is_simulator = True
                                break
                        if is_simulator:
                            break
                except Exception:
                    is_simulator = False

            if is_simulator:
                launch = subprocess.run(
                    ["xcrun", "simctl", "launch", device_id, bundle_id],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if launch.returncode == 0:
                    return {"status": "launched", "device": device_id, "kind": "simulator"}
                return {"status": "failed", "message": (launch.stderr or launch.stdout or "Failed to launch app").strip()}

            launch = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pymobiledevice3",
                    "developer",
                    "core-device",
                    "launch-application",
                    "--tunnel",
                    device_id,
                    "--kill-existing",
                    bundle_id,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if launch.returncode == 0:
                return {"status": "launched", "device": device_id, "kind": "physical"}
            return {"status": "failed", "message": (launch.stderr or launch.stdout or "Failed to launch app").strip()}
        except Exception as exc:
            return {"status": "failed", "message": str(exc)}

    async def _advance_to_next_screen(self, seen_signatures):
        if not self.service:
            return None

        try:
            await self.move("first")
        except Exception:
            pass

        for _ in range(12):
            focused = getattr(self, "current_element", None)
            current_snapshot = self._snapshot_visible_element(focused) if focused is not None else None
            if current_snapshot and self._is_navigation_candidate(current_snapshot):
                before_elements = await self._snapshot_visible_elements(limit=24)
                before_signature = self._screen_signature(self.current_screen_name or "", before_elements)
                activation = await self.activate()
                if activation.get("error"):
                    await self.move("next")
                    continue

                await self._sync_latest_focus_event(timeout=0.5)
                after_elements = await self._snapshot_visible_elements(limit=24)
                after_signature = self._screen_signature(self.current_screen_name or "", after_elements)
                if after_signature not in seen_signatures and after_signature != before_signature:
                    return {
                        "from": before_signature,
                        "to": after_signature,
                        "trigger": current_snapshot.get("label") or current_snapshot.get("caption") or "",
                        "action": "activate",
                        "note": activation.get("note") or activation.get("warning") or "Activated",
                    }

            await self.move("next")

        return None

    async def scan_app_flow(self, bundle_id, device_id=None, scan_mode="single-screen", max_screens=5):
        if not bundle_id:
            return {"error": "Missing bundleId"}

        scan_mode = str(scan_mode or "single-screen").strip().lower()
        full_flow = scan_mode in {"full-flow", "full", "flow"}
        max_screens = max(1, int(max_screens or 5))

        target_device = str(device_id or "").strip()
        if not target_device:
            target_device = self._detect_connected_device()

        if not target_device:
            return {
                "error": "No connected physical device found for App Scan. Select a connected device and try again."
            }

        launch_info = self._launch_app_if_needed(bundle_id, target_device)

        if self._is_simulator_device(target_device):
            audit = self._run_swift_audit(target_device, bundle_id)
            if audit.get("error"):
                return {"error": audit["error"]}

            screen_name = audit.get("screen") or bundle_id
            screen = {
                "name": screen_name,
                "signature": self._screen_signature(screen_name, []),
                "elements": [],
                "issues": audit.get("issues", []),
                "count": audit.get("count", len(audit.get("issues", []))),
                "severityCounts": {
                    "error": len([issue for issue in audit.get("issues", []) if issue.get("severity") == "error"]),
                    "warning": len([issue for issue in audit.get("issues", []) if issue.get("severity") == "warning"]),
                    "hint": len([issue for issue in audit.get("issues", []) if issue.get("severity") == "hint"]),
                },
            }
            flow = self._aggregate_flow([screen])
            return {
                "bundleId": bundle_id,
                "device": target_device,
                "mode": "full-flow" if full_flow else "single-screen",
                "screen": screen_name,
                "issues": screen["issues"] if not full_flow else flow["issues"],
                "count": len(screen["issues"] if not full_flow else flow["issues"]),
                "flow": {
                    **flow,
                    "screens": [screen],
                    "transitions": [],
                    "launch": launch_info,
                    "navigationSupported": False,
                    "note": "Full-flow navigation requires a physical device. This run used the simulator fallback.",
                },
            }

        await self.connect(target_device)

        screens = []
        seen_signatures = set()
        transitions = []

        try:
            await self.move("first")
        except Exception:
            pass

        while len(screens) < max_screens:
            screen = await self._capture_screen(bundle_id)
            if screen["signature"] in seen_signatures:
                break
            seen_signatures.add(screen["signature"])
            screens.append(screen)

            if not full_flow or len(screens) >= max_screens:
                break

            moved = await self._advance_to_next_screen(seen_signatures)
            if not moved:
                break

            transitions.append(moved)

        flow = self._aggregate_flow(screens)
        first_screen = screens[0] if screens else {"name": "Screen", "issues": [], "count": 0}
        top_level_issues = first_screen["issues"] if not full_flow else flow["issues"]

        return {
            "bundleId": bundle_id,
            "device": target_device,
            "mode": "full-flow" if full_flow else "single-screen",
            "screen": first_screen["name"],
            "issues": top_level_issues,
            "count": len(top_level_issues),
            "flow": {
                **flow,
                "screens": screens,
                "transitions": transitions,
                "launch": launch_info,
            },
        }

    def _extract_screen_name(self, value):
        if value is None:
            return ""

        if isinstance(value, dict):
            for key in ["screen", "context", "window", "title", "application", "bundle", "name"]:
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
            for candidate in value.values():
                found = self._extract_screen_name(candidate)
                if found:
                    return found
            return ""

        for attr in ["screen_name", "screen", "context_name", "context", "application_name", "bundle_identifier", "bundle_id", "name", "title"]:
            candidate = getattr(value, attr, None)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()

        return ""

    def _extract_element_reference(self, value, fallback_text=""):
        label = ""
        identifier = ""

        if isinstance(value, dict):
            for key in ["caption", "spoken_description", "label", "text", "announcement"]:
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    label = candidate.strip()
                    break
            for key in ["estimated_uid", "platform_identifier", "identifier", "id"]:
                candidate = value.get(key)
                if candidate is None:
                    continue
                if isinstance(candidate, bytes):
                    candidate = candidate.hex()
                identifier = str(candidate).strip()
                if identifier:
                    break
        else:
            for attr in ["caption", "spoken_description", "label", "text"]:
                candidate = getattr(value, attr, None)
                if isinstance(candidate, str) and candidate.strip():
                    label = candidate.strip()
                    break
            for attr in ["estimated_uid", "platform_identifier", "identifier", "id"]:
                candidate = getattr(value, attr, None)
                if candidate is None:
                    continue
                if isinstance(candidate, bytes):
                    candidate = candidate.hex()
                identifier = str(candidate).strip()
                if identifier:
                    break

        if not label:
            label = fallback_text.strip()

        return {"label": label, "id": identifier}

    def _build_element_reference(self, value, fallback_text=""):
        element = self._extract_element_reference(value, fallback_text=fallback_text)
        if not element.get("label"):
            element["label"] = fallback_text.strip()
        return element

    def _announcement_signature(self, event):
        element = event.get("element") or {}
        return "|".join([
            str(event.get("type") or event.get("event_type") or ""),
            str(event.get("text") or "").lower(),
            str(event.get("screen") or "").lower(),
            str(element.get("label") or "").lower(),
            str(element.get("id") or "").lower(),
        ])

    def _should_emit_announcement(self, event):
        text = str(event.get("text") or "").strip()
        if not text:
            return False

        type_name = str(event.get("type") or event.get("event_type") or "dynamic_update")
        lowered = text.lower()
        noisy = [
            "double tap to activate",
            "double-tap to activate",
            "swipe up or down",
            "swipe left or right",
            "adjustable",
            "hint",
            "hints available",
        ]
        if type_name in {"dynamic_update", "focus_change"} and any(token in lowered for token in noisy):
            return False

        signature = self._announcement_signature(event)
        now = datetime.now(timezone.utc)
        previous = self._announcement_recent_signatures.get(signature)
        if previous is not None:
            delta = (now - previous).total_seconds()
            if delta < 1.5:
                return False

        self._announcement_recent_signatures[signature] = now
        cutoff = now.timestamp() - 8.0
        self._announcement_recent_signatures = {
            key: seen for key, seen in self._announcement_recent_signatures.items()
            if seen.timestamp() >= cutoff
        }
        return True

    async def activate(self):
        """Press/activate the current element."""
        if not self.service:
            return {"error": "Not connected"}

        try:
            # If user changed focus on-device (outside nav commands), sync latest event first.
            await self._sync_latest_focus_event()

            # If we still do not have a focused element, acquire one explicitly.
            if self.current_element_bytes is None:
                await self.service.move_focus(Direction.Next)
                focused = await self._read_focused_element()
                if focused.get("error"):
                    return focused

            if self.current_element_bytes is None:
                return {"error": "No element focused. Use next/previous/first first."}

            element_ref = self.current_element_bytes

            # Prefer the focused element's declared Activate action if present.
            activate_action = None
            for action in self.current_actions:
                name = action.get("HumanReadableNameValue_v1")
                attr = action.get("AttributeNameValue_v1")
                performs = action.get("PerformsActionValue_v1")
                if name == "Activate" or attr == "AXAction-2010":
                    if performs is False:
                        continue
                    activate_action = action
                    break

            if activate_action is not None:
                element_payload = {
                    "ObjectType": "AXAuditElement_v1",
                    "Value": {
                        "ObjectType": "passthrough",
                        "Value": {
                            "PlatformElementValue_v1": {"ObjectType": "passthrough"},
                            "Value": element_ref,
                        },
                    },
                }
                action_payload = self._build_action_payload(activate_action)
                await self.service._invoke(
                    "deviceElement:performAction:withValue:",
                    element_payload,
                    action_payload,
                    0,
                    expects_reply=False,
                )
            else:
                # Fallback for elements that do not expose action metadata.
                await self.service.perform_press(element_ref)

            # Detect whether the action had a visible effect. Some apps (especially
            # system apps / non-debuggable targets) acknowledge the call but ignore it.
            before_caption = getattr(self.current_element, "caption", None)
            await self._sync_latest_focus_event(timeout=0.7)
            after_caption = getattr(self.current_element, "caption", None)

            if before_caption == after_caption:
                # Some iOS 16 controls ignore performAction but react to perform_press.
                if activate_action is not None:
                    await self.service.perform_press(element_ref)
                    await self._sync_latest_focus_event(timeout=0.7)
                    after_press_caption = getattr(self.current_element, "caption", None)
                    if after_press_caption != before_caption:
                        return {
                            "ok": True,
                            "action": "activate",
                            "note": "Activated via AX press fallback.",
                        }

                wda_ok, wda_info = self._attempt_wda_tap_fallback()
                if wda_ok:
                    # Confirm a visible focus/UI update after WDA fallback tap.
                    await self._sync_latest_focus_event(timeout=1.5)
                    after_wda_caption = getattr(self.current_element, "caption", None)
                    if after_wda_caption != before_caption:
                        return {
                            "ok": True,
                            "action": "activate",
                            "note": "AX activate had no UI change; WDA tap fallback succeeded.",
                        }

                    return {
                        "ok": False,
                        "warning": (
                            "WDA tap command succeeded, but no focus/UI change was detected. "
                            "The element may be non-activatable or a control that does not change focus."
                        ),
                    }

                platform_hint = self._activation_help_hint()
                return {
                    "ok": False,
                    "warning": (
                        "Activate was sent, but no UI change was detected. "
                        "This can happen on system or non-debuggable apps. "
                        f"WDA fallback also failed ({wda_info}). {platform_hint}"
                    ),
                }

            return {"ok": True, "action": "activate"}
        except Exception as e:
            return {"error": f"Activate failed: {e}"}

    async def list_elements(self):
        """List all visible accessibility elements."""
        if not self.service:
            return {"error": "Not connected"}

        elements = await self._snapshot_visible_elements(limit=200)

        return {"ok": True, "elements": elements, "count": len(elements)}

    async def start_announcement_monitor(self):
        if not self.service:
            return {"error": "Not connected"}

        if self._announcement_monitor_task and not self._announcement_monitor_task.done():
            return {"ok": True, "monitoring": "announcements"}

        self._announcement_recent_signatures = {}
        self._last_announcement_signature = None
        self._announcement_monitor_running = True
        self._announcement_monitor_task = asyncio.create_task(self._monitor_announcements())
        return {"ok": True, "monitoring": "announcements"}

    async def stop_announcement_monitor(self):
        self._announcement_monitor_running = False

        if self._announcement_monitor_task:
            self._announcement_monitor_task.cancel()
            try:
                await self._announcement_monitor_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            self._announcement_monitor_task = None

        return {"ok": True}

    async def _monitor_announcements(self):
        if not self.service:
            return

        from pymobiledevice3.services.accessibilityaudit import Event

        while self._announcement_monitor_running and self.service:
            try:
                name, args = await self.service._event_queue.get()
            except asyncio.CancelledError:
                return
            except Exception:
                return

            payload = self.service._extract_event_payload(args)
            if payload is None:
                continue

            try:
                event = Event(name=name, data=deserialize_object(payload))
            except Exception:
                continue

            emitted_focus_announcement = False
            if event.name == "hostInspectorCurrentElementChanged:":
                if isinstance(event.data, list) and event.data:
                    self._cache_focus_item(event.data[0])
                    focus_event = self._build_focus_announcement_event(event.data[0], event.name)
                    if focus_event:
                        write_announcement_event(focus_event)
                        emitted_focus_announcement = True
                elif event.data is not None:
                    self._cache_focus_item(event.data)
                    focus_event = self._build_focus_announcement_event(event.data, event.name)
                    if focus_event:
                        write_announcement_event(focus_event)
                        emitted_focus_announcement = True

            if emitted_focus_announcement:
                continue

            announcement_event = self._build_announcement_event(event)
            if announcement_event:
                write_announcement_event(announcement_event)

    async def disconnect(self):
        await self.stop_announcement_monitor()
        if self.service:
            try:
                await self.service.close()
            except Exception:
                pass
            self.service = None
        self.lockdown = None
        self.udid = None
        return {"ok": True}


def write_response(data):
    sys.stdout.write(json.dumps(data) + "\n")
    sys.stdout.flush()


def write_focus_event(event):
    if not event:
        return
    write_response({"type": "focus:event", "event": event})


def write_announcement_event(event):
    if not event:
        return
    write_response({"type": "announcement:event", "event": event})


async def main():
    bridge = AccessibilityBridge()

    write_response({"ready": True})

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line_bytes = await reader.readline()
        if not line_bytes:
            break
        line = line_bytes.decode().strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            write_response({"error": "Invalid JSON"})
            continue

        action = cmd.get("action", "")

        try:
            if action == "connect":
                result = await bridge.connect(cmd.get("udid", ""))
            elif action in ("next", "previous", "first", "last"):
                result = await bridge.move(action)
            elif action == "activate":
                result = await bridge.activate()
            elif action == "list":
                result = await bridge.list_elements()
            elif action == "monitor_announcements":
                result = await bridge.start_announcement_monitor()
            elif action == "stop_monitor_announcements":
                result = await bridge.stop_announcement_monitor()
            elif action == "disconnect":
                result = await bridge.disconnect()
                write_response(result)
                return
            else:
                result = {"error": f"Unknown action: {action}"}
        except Exception as e:
            result = {"error": str(e)}

        focus_event = result.pop("focus_event", None) if isinstance(result, dict) else None
        if focus_event:
            write_focus_event(focus_event)
        write_response(result)


def list_apps():
    # TODO: Replace with real simulator query (placeholder)
    apps = [
        {"bundleId": "com.example.demo", "name": "Demo App"},
        {"bundleId": "com.example.todo", "name": "Todo App"}
    ]
    print(json.dumps(apps))

async def scan_app(bundle_id, device_id="", scan_mode="single-screen", max_screens=5):
    bridge = AccessibilityBridge()
    result = await bridge.scan_app_flow(
        bundle_id=bundle_id,
        device_id=device_id,
        scan_mode=scan_mode,
        max_screens=max_screens,
    )
    print(json.dumps(result))

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "list-apps":
        list_apps()
    elif len(sys.argv) > 2 and sys.argv[1] == "scan-app":
        bundle_id = sys.argv[2]
        device_id = sys.argv[3] if len(sys.argv) > 3 else ""
        scan_mode = sys.argv[4] if len(sys.argv) > 4 else "single-screen"
        max_screens = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 5
        asyncio.run(scan_app(bundle_id, device_id=device_id, scan_mode=scan_mode, max_screens=max_screens))
    else:
        asyncio.run(main())
