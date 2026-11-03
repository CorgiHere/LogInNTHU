# -*- coding: utf-8 -*-
"""Local portal picker. Credentials stay in the browser; this process only listens on localhost."""

import base64
import json
import os
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import bot

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8756

_jobs = {}
_jobs_lock = threading.Lock()
_queue = None
_handoff = None
_handoff_lock = threading.Lock()


class Worker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.session = bot.BrowserSession()

    def run(self):
        try:
            bot.engines()
            print("驗證碼模型已載入", flush=True)
        except Exception as exc:
            print(f"驗證碼模型載入失敗：{exc}", flush=True)
        while True:
            job_id, portal_id, account, password = _queue.get()
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                continue
            job["status"] = "running"

            def log(message, job=job):
                job["message"] = message
                job["log"].append(message)

            try:
                result = self.session.sign_in(portal_id, account, password, log)
            except Exception as exc:
                result = {"status": "error", "message": f"登入中斷：{exc}"}
            job["status"] = result.get("status", "error")
            job["message"] = result.get("message") or job["message"]
            if job["message"] and (not job["log"] or job["log"][-1] != job["message"]):
                job["log"].append(job["message"])
            if result.get("url"):
                job["url"] = result["url"]


def _busy() -> bool:
    with _jobs_lock:
        return any(job["status"] in ("queued", "running") for job in _jobs.values())


class Handler(BaseHTTPRequestHandler):
    server_version = "NTHULogin/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        allowed = {f"http://{HOST}:{PORT}", f"http://localhost:{PORT}"}
        return origin in allowed

    def _send(self, status, payload=None, body=None, content_type="application/json; charset=utf-8"):
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body or b"")))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/handoff":
            self._send(200, {"ok": True, "job": _current_handoff()})
            return
        if path == "/nthu-login.user.js":
            file_path = ROOT / "docs" / "nthu-login.user.js"
            self._send(200, body=file_path.read_bytes(), content_type="text/javascript; charset=utf-8")
            return
        if path.startswith("/api/jobs/"):
            job_id = path.split("/")[-1]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send(404, {"ok": False, "error": "找不到這次登入"})
                return
            self._send(200, {"ok": True, "job": job})
            return

        name = {"": "index.html", "/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}.get(path)
        if name is None:
            self._send(404, body=b"not found", content_type="text/plain; charset=utf-8")
            return
        file_path = STATIC / name
        kind = {
            "index.html": "text/html; charset=utf-8",
            "app.js": "text/javascript; charset=utf-8",
            "style.css": "text/css; charset=utf-8",
        }[name]
        self._send(200, body=file_path.read_bytes(), content_type=kind)

    def _json(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _ocr(self):
        data = self._json(2_000_000)
        if not isinstance(data, dict):
            self._send(400, {"ok": False, "error": "資料不正確"})
            return
        try:
            length = int(data.get("length"))
        except (TypeError, ValueError):
            length = 0
        if length not in (4, 6):
            self._send(400, {"ok": False, "error": "長度不對"})
            return
        image = str(data.get("image") or "")
        if image.startswith("data:") and "," in image:
            image = image.split(",", 1)[1]
        try:
            raw = base64.b64decode(image)
        except Exception:
            self._send(400, {"ok": False, "error": "圖片不正確"})
            return
        if not raw or len(raw) > 1_500_000:
            self._send(400, {"ok": False, "error": "圖片不正確"})
            return
        self._send(200, {"ok": True, "code": bot.read_captcha(raw, length)})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/handoff":
            _save_handoff_from(self)
            return
        if path == "/api/ocr":
            self._ocr()
            return
        if path != "/api/login":
            self._send(404, {"ok": False, "error": "找不到這個功能"})
            return
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "只接受這個網站自己送出的登入"})
            return
        data = self._json(10000)
        if not isinstance(data, dict):
            self._send(400, {"ok": False, "error": "資料不正確"})
            return

        portal_id = data.get("portal")
        account = str(data.get("account") or "").strip()
        password = str(data.get("password") or "")
        if portal_id not in bot.PORTALS:
            self._send(400, {"ok": False, "error": "沒有這個系統"})
            return
        if not account or not password:
            self._send(400, {"ok": False, "error": "請先填寫帳號和密碼"})
            return
        if len(account) > 42 or len(password) > 64:
            self._send(400, {"ok": False, "error": "帳號或密碼長度過長"})
            return
        if _busy():
            self._send(409, {"ok": False, "error": "上一個登入還在進行，請稍候"})
            return

        self._send(200, {
            "ok": True,
            "url": {
                "ccxp": "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/",
                "elearn": "https://elearn.nthu.edu.tw/auth/oauth2/login.php?id=5&wantsurl=/",
                "eeclass": bot.EECLASS_OAUTH,
                "library": bot.LIBRARY_URL,
            }.get(portal_id),
        })


def _current_handoff():
    with _handoff_lock:
        job = _handoff
    if not job or job["until"] < time.time():
        return None
    return {
        "portal": job["portal"],
        "account": job["account"],
        "password": job["password"],
        "libraryAccount": job["libraryAccount"],
        "libraryPassword": job["libraryPassword"],
    }


def _save_handoff_from(handler):
    if not handler._origin_ok():
        handler._send(403, {"ok": False, "error": "只接受這個網站自己送出的登入"})
        return
    data = handler._json(10000)
    if not isinstance(data, dict):
        handler._send(400, {"ok": False, "error": "資料不正確"})
        return
    portal_id = data.get("portal")
    if portal_id not in bot.PORTALS:
        handler._send(400, {"ok": False, "error": "沒有這個系統"})
        return
    account = str(data.get("account") or "")
    password = str(data.get("password") or "")
    library_account = str(data.get("libraryAccount") or "")
    library_password = str(data.get("libraryPassword") or "")
    picked_id = library_account if portal_id == "library" else account
    picked_secret = library_password if portal_id == "library" else password
    if not picked_id.strip() or not picked_secret:
        handler._send(400, {"ok": False, "error": "請先填寫帳號和密碼"})
        return
    if max(len(account), len(library_account)) > 42 or max(len(password), len(library_password)) > 64:
        handler._send(400, {"ok": False, "error": "帳號或密碼長度過長"})
        return
    global _handoff
    with _handoff_lock:
        _handoff = {
            "portal": portal_id,
            "account": account.strip(),
            "password": password,
            "libraryAccount": library_account.strip(),
            "libraryPassword": library_password,
            "until": time.time() + 180,
        }
    handler._send(200, {"ok": True})


def _open_portal(url):
    try:
        bot.open_tab(url)
    except Exception:
        webbrowser.open(url)


def serve():
    global _queue
    _queue = __import__("queue").Queue()
    Worker().start()
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print(f"無法在 {HOST}:{PORT} 啟動：{exc}")
        return 1
    url = f"http://{HOST}:{PORT}/"
    print(f"清大入口已開啟 {url}", flush=True)
    print("帳號密碼只留在瀏覽器裡。關閉這個視窗就會停止程式。", flush=True)
    if os.environ.get("NTHU_NO_BROWSER") != "1":
        threading.Timer(0.6, lambda: _open_portal(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


def main():
    if "--check" in sys.argv:
        raise SystemExit(bot.check())
    raise SystemExit(serve())


if __name__ == "__main__":
    main()
