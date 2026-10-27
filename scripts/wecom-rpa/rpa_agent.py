# -*- coding: utf-8 -*-
"""
WeCom Windows PC RPA Automation Agent (Clean ASCII version)
"""

import sys
import os
import time
import json
import logging
import threading
import ctypes
from typing import List, Dict, Optional, Set
import requests

try:
    import uiautomation as auto
    import pyperclip
except ImportError:
    print("[ERROR] Missing packages! Run: pip install uiautomation pyperclip requests flask")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("wecom_rpa.log", encoding="utf-8")
    ]
)
logger = logging.getLogger("WecomRPA")

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

DEFAULT_CONFIG = {
    "app_backend_url": "http://124.222.117.150/api/admin/wecom/finance-inbound",
    # Inbound is delivered by the WeCom chat-archive sidecar; keep RPA scraping off to avoid duplicates
    "inbound_enabled": False,
    # Only needed when inbound_enabled=true; set it in config.json (never commit the real value)
    "sidecar_token": "",
    # Display names of the RPA-logged-in account; their messages are not dispatched (prevents reply loops)
    "self_names": ["\u8f66\u548c\u7f51\u5ba2\u670d"],
    "rpa_server_port": 5005,
    "bot_name": "\u8f66\u548c\u7f51\u667a\u80fdAgent",
    "poll_interval_sec": 1.5,
    "group_whitelist": [],
    "min_send_delay_sec": 1.0,
    "max_send_delay_sec": 2.5
}

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return {**DEFAULT_CONFIG, **cfg}
        except Exception as e:
            logger.error(f"Read config failed, using defaults: {e}")
    return DEFAULT_CONFIG

config = load_config()

WECOM_NAME = "\u4f01\u4e1a\u5fae\u4fe1"  # "企业微信"
SEARCH_NAME = "\u641c\u7d22"             # "搜索"


class WindowsKeepAlive:
    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    ES_DISPLAY_REQUIRED = 0x00000002

    @classmethod
    def enable(cls):
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(
                cls.ES_CONTINUOUS | cls.ES_SYSTEM_REQUIRED | cls.ES_DISPLAY_REQUIRED
            )
            logger.info("Windows KeepAlive screen lock prevention enabled")
        except Exception as e:
            logger.warning(f"Enable KeepAlive failed: {e}")


class WecomRPAEngine:
    def __init__(self):
        self.wecom_window = None
        self.processed_msg_signatures: Set[str] = set()
        self.lock = threading.Lock()
        self.running = True

    def find_wecom_window(self):
        wnd = auto.WindowControl(searchDepth=1, ClassName="WeChatWorkWnd", Name=WECOM_NAME)
        if not wnd.Exists(0, 0):
            wnd = auto.WindowControl(searchDepth=1, Name=WECOM_NAME)
        if wnd.Exists(0, 0):
            self.wecom_window = wnd
            return True
        return False

    def ensure_active(self) -> bool:
        if not self.wecom_window or not self.wecom_window.Exists(0, 0):
            if not self.find_wecom_window():
                logger.warning("WeCom window not found. Please open and login WeCom PC client.")
                return False
        try:
            handle = getattr(self.wecom_window, "NativeWindowHandle", 0)
            if handle:
                ctypes.windll.user32.ShowWindow(handle, 9)  # SW_RESTORE
                ctypes.windll.user32.SetForegroundWindow(handle)
            else:
                self.wecom_window.SetActive()
            return True
        except Exception as e:
            logger.error(f"Activate WeCom window failed: {e}")
            return False

    def scan_active_chat(self) -> Optional[Dict]:
        if not self.ensure_active():
            return None

        chat_title = None
        try:
            header = self.wecom_window.PaneControl(searchDepth=5, ClassName="ChatHeaderView")
            if header.Exists(0, 0):
                chat_title = header.TextControl().Name
        except Exception:
            pass

        if not chat_title:
            chat_title = "external_group"

        if config["group_whitelist"] and chat_title not in config["group_whitelist"]:
            return None

        messages = self.extract_recent_messages()
        new_msgs = []
        for msg in messages:
            sig = f"{chat_title}_{msg.get('sender')}_{msg.get('content')}_{msg.get('time')}"
            if sig not in self.processed_msg_signatures:
                self.processed_msg_signatures.add(sig)
                if len(self.processed_msg_signatures) > 10000:
                    self.processed_msg_signatures.clear()
                new_msgs.append(msg)

        if new_msgs:
            return {
                "chat_title": chat_title,
                "messages": new_msgs
            }
        return None

    def extract_recent_messages(self) -> List[Dict]:
        msgs = []
        try:
            msg_list = self.wecom_window.ListControl(searchDepth=8)
            if not msg_list.Exists(0, 0):
                return msgs

            items = msg_list.GetChildren()
            for item in items[-5:]:
                try:
                    text_ctrls = item.GetChildren()
                    texts = [c.Name for c in text_ctrls if hasattr(c, "Name") and c.Name]
                    if texts:
                        sender = texts[0] if len(texts) > 1 else "member"
                        content = texts[-1]
                        msgs.append({
                            "sender": sender,
                            "content": content,
                            "time": int(time.time() * 1000)
                        })
                except Exception:
                    continue
        except Exception as e:
            logger.debug(f"Extract messages exception: {e}")
        return msgs

    def _click_ratio(self, rx: float, ry: float):
        rect = self.wecom_window.BoundingRectangle
        x = int(rect.left + (rect.right - rect.left) * rx)
        y = int(rect.top + (rect.bottom - rect.top) * ry)
        auto.Click(x, y, waitTime=0.2)

    def send_message(self, chat_title: str, text: str) -> bool:
        with self.lock:
            if not self.ensure_active():
                return False

            try:
                time.sleep(0.3)
                # 1) open target chat: Ctrl+F focuses WeCom global search
                auto.SendKeys("{Ctrl}f", waitTime=0.3)
                auto.SendKeys("{Ctrl}a", waitTime=0.1)
                pyperclip.copy(chat_title)
                auto.SendKeys("{Ctrl}v", waitTime=0.2)
                time.sleep(float(config.get("search_wait_sec", 1.2)))
                auto.SendKeys("{Enter}", waitTime=0.6)

                # 2) focus message input box (bottom of right pane), ratios configurable
                self._click_ratio(float(config.get("input_x_ratio", 0.62)),
                                  float(config.get("input_y_ratio", 0.90)))
                time.sleep(0.3)

                # 3) paste and send
                pyperclip.copy(text)
                auto.SendKeys("{Ctrl}v", waitTime=0.3)
                auto.SendKeys("{Enter}", waitTime=0.2)
                logger.info(f"Sent reply to [{chat_title}]: {text[:30]}...")
                return True
            except Exception as e:
                logger.error(f"Send message to [{chat_title}] failed: {e}")
                return False

    def dispatch_to_backend(self, chat_title: str, msg: Dict):
        url = config["app_backend_url"]
        payload = {
            "seq": int(time.time() * 1000),
            "msgid": f"rpa_{int(time.time()*1000)}_{abs(hash(msg['content'])) % 100000}",
            "isExternalRoom": True,
            "roomid": chat_title,
            "sender": msg.get("sender", "unknown"),
            "timestamp": msg.get("time", int(time.time() * 1000)),
            "msgtype": "text",
            "contentSummary": msg.get("content", ""),
            "payload": {
                "msgid": f"rpa_{int(time.time()*1000)}",
                "action": "send",
                "from": msg.get("sender", "unknown"),
                "tolist": [],
                "roomid": chat_title,
                "msgtime": int(time.time()),
                "msgtype": "text",
                "text": {
                    "content": msg.get("content", "")
                }
            }
        }
        try:
            headers = {"x-sidecar-token": config.get("sidecar_token", "")}
            resp = requests.post(url, json=payload, headers=headers, timeout=5)
            logger.info(f"Dispatched message: [{chat_title}] {msg['sender']}: {msg['content']} (HTTP {resp.status_code})")
        except Exception as e:
            logger.warning(f"Dispatch to backend failed (URL: {url}): {e}")

    def loop(self):
        logger.info("WeCom RPA message listener loop running...")
        if not config.get("inbound_enabled", False):
            logger.info("Inbound scraping disabled (inbound_enabled=false); send-only mode")
            while self.running:
                time.sleep(5)
            return
        while self.running:
            try:
                res = self.scan_active_chat()
                if res:
                    for m in res["messages"]:
                        if m.get("sender") in config.get("self_names", []):
                            continue
                        self.dispatch_to_backend(res["chat_title"], m)
            except Exception as e:
                logger.error(f"Listener loop exception: {e}")
            time.sleep(config["poll_interval_sec"])


engine = WecomRPAEngine()


def run_http_server():
    from flask import Flask, request, jsonify
    app = Flask("WecomRPAServer")

    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    @app.route("/api/rpa/send", methods=["POST"])
    def handle_send():
        data = request.json or {}
        chat_title = data.get("chatId") or data.get("roomid") or data.get("channelChatId")
        content = data.get("content") or data.get("text")
        if not chat_title or not content:
            return jsonify({"code": 400, "message": "Missing chatId or content"}), 400

        success = False
        try:
            with auto.UIAutomationInitializerInThread():
                success = engine.send_message(chat_title, content)
        except Exception:
            import traceback
            logger.error("RPA send exception:\n" + traceback.format_exc())
        return jsonify({
            "code": 0 if success else 500,
            "message": "success" if success else "failed"
        })

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok", "wecom_connected": engine.find_wecom_window()})

    port = config.get("rpa_server_port", 5005)
    logger.info(f"RPA HTTP server listening on port: {port}")
    app.run(host="0.0.0.0", port=port, debug=False)


def main():
    WindowsKeepAlive.enable()
    server_thread = threading.Thread(target=run_http_server, daemon=True)
    server_thread.start()
    engine.loop()


if __name__ == "__main__":
    main()
