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
import subprocess
import sys

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
        self.current_actions = []
        self._monitoring_ready = False

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

    def _run_wda_tap(self, selector, using):
        """Try WDA tap by selector. Returns None on success or error text on failure."""
        if not self.udid:
            return "No device UDID available for WDA tap"

        cmd = [
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
            selector,
        ]

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

        return (stderr_text or stdout_text or "WDA tap failed").strip()

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
        errors = []

        for sel in candidates:
            for using in strategies:
                err = self._run_wda_tap(sel, using)
                if err is None:
                    return True, f"WDA tap succeeded via {using}: {sel}"
                errors.append(f"{using}:{sel}: {err}")

        return False, (errors[-1] if errors else "Unknown WDA error")

    def _cache_focus_item(self, current_item):
        """Store the latest focused item and its element identifier bytes."""
        self.current_element = current_item
        element_obj = getattr(current_item, "element", None)
        self.current_element_bytes = (
            element_obj.identifier if element_obj is not None else None
        )
        self.current_actions = self._extract_actions(current_item)

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

        await self.service.move_focus(d)

        # Read the focused element from the event queue (no extra move)
        return await self._read_focused_element()

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
                return self._format_element(current_item)
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

        elements = []
        async for item in self.service.iter_elements():
            elements.append(self._format_element(item).get("element", {}))
            if len(elements) > 200:
                break

        return {"ok": True, "elements": elements, "count": len(elements)}

    async def disconnect(self):
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
            elif action == "disconnect":
                result = await bridge.disconnect()
                write_response(result)
                return
            else:
                result = {"error": f"Unknown action: {action}"}
        except Exception as e:
            result = {"error": str(e)}

        write_response(result)


if __name__ == "__main__":
    asyncio.run(main())
