# -*- coding: utf-8 -*-
"""Local portal picker. Credentials stay in the browser; this process only listens on localhost."""

import json
import sys
import threading
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

    def do_POST(self):
        if urlparse(self.path).path != "/api/login":
            self._send(404, {"ok": False, "error": "找不到這個功能"})
            return
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "只接受這個網站自己送出的登入"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 10000:
            self._send(400, {"ok": False, "error": "資料不正確"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
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

        job_id = uuid.uuid4().hex
        name = bot.PORTALS[portal_id]["name"]
        job = {
            "id": job_id,
            "portal": portal_id,
            "status": "queued",
            "message": f"準備進入{name}",
            "log": [f"準備進入{name}"],
        }
        with _jobs_lock:
            _jobs[job_id] = job
        _queue.put((job_id, portal_id, account, password))
        self._send(200, {"ok": True, "id": job_id})


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
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
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
