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
        self.current_element = None
        self.current_element_bytes = None
        self._monitoring_ready = False

    async def connect(self, udid):
        self.lockdown = await create_using_usbmux(serial=udid)
        self.service = AccessibilityAudit(self.lockdown)
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

                self.current_element = current_item
                element_obj = getattr(current_item, "element", None)
                self.current_element_bytes = element_obj.identifier if element_obj is not None else None
                return self._format_element(current_item)
        except Exception as e:
            return {"error": str(e)}

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
        if self.current_element_bytes is None:
            return {"error": "No element focused. Use next/previous/first first."}

        try:
            element_ref = self.current_element_bytes
            await self.service.perform_press(element_ref)
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
