# -*- coding: utf-8 -*-
"""Open a tab in the user's Brave and sign in to the user's own NTHU portals."""

import io
import os
import subprocess
import time
import urllib.request
from pathlib import Path

import ddddocr
from PIL import Image
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PROFILE_DIR = ROOT / ".browser-profile-brave"
DEBUG_PORT = 9222


def browser_executable() -> Path:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "BraveSoftware/Brave-Browser/Application/brave.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "BraveSoftware/Brave-Browser/Application/brave.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "BraveSoftware/Brave-Browser/Application/brave.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise FileNotFoundError("找不到 Brave")


def open_tab(url: str):
    """Hand the address to the Brave that is already open, so it becomes a tab."""
    subprocess.Popen(
        [str(browser_executable()), "--profile-directory=Default", url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def _debugging_ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1) as resp:
            return resp.status == 200
    except Exception:
        return False


def ensure_brave_tab_host():
    """Never close Brave or start another window. Attach only when it is already possible."""
    if _debugging_ready():
        return
    raise RuntimeError("不會關閉目前的 Brave，也不會另開視窗")

CCXP_URL = "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/"
ELEARN_URL = "https://elearn.nthu.edu.tw/"
EECLASS_URL = "https://eeclass.nthu.edu.tw/"
# Same authorize URL the eeclass login button uses. sesskey-less; state is empty on purpose.
EECLASS_OAUTH = (
    "https://oauth.ccxp.nthu.edu.tw/v1.1/authorize.php"
    "?response_type=code&client_id=eeclass"
    "&redirect_uri=https%3A%2F%2Feeclass.nthu.edu.tw%2Fservice%2Foauth%2F"
    "&scope=lmsid+userid&state=&ui_locales=zh-TW"
)
LIBRARY_URL = (
    "https://idm.nthu.ust.edu.tw/sso/886UST_NTHU/oidc/login/"
    "?next=/openid/886UST_NTHU/authorize/%3Fclient_id%3D227897"
    "%26response_type%3Dcode%26redirect_uri%3Dhttps%3A//libsms.lib.nthu.edu.tw/openidcallback.aspx"
    "%26state%3DRWD%26scope%3Dopenid"
)

_ENGINES = None


def engines():
    """The newer captcha model. The older one was voting it down on these digit images."""
    global _ENGINES
    if _ENGINES is None:
        engine = ddddocr.DdddOcr(show_ad=False, beta=True)
        engine.set_ranges("0123456789")
        _ENGINES = engine
    return _ENGINES


def _resample(raw: bytes, height: int) -> bytes:
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    width = max(1, int(image.width * (height / image.height)))
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _digits_from_probability(result) -> tuple:
    """Pick the most likely digit at each step, instead of dropping a letter lookalike."""
    if not isinstance(result, dict):
        digits = "".join(ch for ch in str(result) if ch.isdigit())
        return digits, 0.0
    charset = result.get("charset") or result.get("charsets") or []
    probs = result.get("probabilities") or result.get("probability")
    if not charset or not probs:
        digits = "".join(ch for ch in str(result.get("text") or "") if ch.isdigit())
        return digits, float(result.get("confidence") or 0)
    digit_index = {char: charset.index(char) for char in "0123456789" if char in charset}
    blank = 0 if charset[0] == "" else None
    chars = []
    scores = []
    previous = None
    for step in probs:
        row = step
        while isinstance(row, list) and row and isinstance(row[0], list):
            row = row[0]
        if not row:
            continue
        best_index = blank
        best_score = row[blank] if blank is not None and blank < len(row) else -1
        for index in digit_index.values():
            if index < len(row) and row[index] > best_score:
                best_score = row[index]
                best_index = index
        if best_index is None or best_index == previous:
            previous = best_index
            continue
        previous = best_index
        if best_index == blank:
            continue
        chars.append(charset[best_index])
        scores.append(best_score)
    confidence = sum(scores) / len(scores) if scores else 0.0
    return "".join(chars), confidence


def read_captcha(raw: bytes, length: int) -> str:
    """Read a numeric captcha with the beta model and keep the most confident exact-length result."""
    blobs = []
    try:
        if 36 <= Image.open(io.BytesIO(raw)).height <= 180:
            blobs.append(raw)
    except Exception:
        pass
    for height in (64, 96):
        try:
            blobs.append(_resample(raw, height))
        except Exception:
            pass
    if not blobs:
        blobs.append(raw)

    engine = engines()
    best = ("", -1.0)
    for blob in blobs:
        try:
            result = engine.classification(blob, png_fix=True, probability=True)
            text, confidence = _digits_from_probability(result)
        except Exception:
            text, confidence = "", 0.0
        if not text:
            continue
        exact = len(text) == length
        best_exact = len(best[0]) == length
        if exact and (not best_exact or confidence > best[1]):
            best = (text, confidence)
        elif not exact and not best_exact and confidence > best[1]:
            best = (text, confidence)
    return best[0]


def _form_visible(page, portal) -> bool:
    try:
        field = page.locator(portal["captcha"])
        return field.count() > 0 and field.first.is_visible()
    except Exception:
        return False


def _wait_until(page, predicate, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for candidate in list(page.context.pages):
            try:
                if candidate.is_closed():
                    continue
                if predicate(candidate):
                    return candidate
            except Exception:
                continue
        page.wait_for_timeout(200)
    return page


def _reach_elearn(page, log):
    if "oauth.ccxp.nthu.edu.tw" in page.url and _form_visible(page, PORTALS["elearn"]):
        return page
    log("等待 elearn 登入連結")
    try:
        page.wait_for_selector("a[href*='auth/oauth2/login.php']", timeout=20000)
    except PlaywrightTimeout:
        return page
    log("從 elearn 首頁取得新的登入連線")
    page.locator("a[href*='auth/oauth2/login.php']").first.click()
    return _wait_until(
        page,
        lambda p: "oauth.ccxp.nthu.edu.tw" in (p.url or ""),
        timeout=20,
    )


def _reach_eeclass(page, log):
    portal = PORTALS["eeclass"]
    if "oauth.ccxp.nthu.edu.tw" in page.url and _form_visible(page, portal):
        return page
    selectors = [
        "a[href*='oauthRedir']",
        "a:has-text('校務資訊系統驗證')",
        "a[href*='oauth.ccxp.nthu.edu.tw']",
        "a[href*='authorize.php']",
    ]
    for selector in selectors:
        link = page.locator(selector)
        if link.count() == 0:
            continue
        log("從 eeclass 進入登入頁")
        try:
            link.first.click(timeout=5000)
        except Exception:
            continue
        landed = _wait_until(
            page,
            lambda p: "oauth.ccxp.nthu.edu.tw" in (p.url or "") or _form_visible(p, portal),
            timeout=12,
        )
        if "oauth.ccxp.nthu.edu.tw" in landed.url or _form_visible(landed, portal):
            return landed
    log("改開 eeclass 的 OAuth 登入頁")
    page.goto(EECLASS_OAUTH, wait_until="domcontentloaded", timeout=30000)
    return page


def _reach_direct(page, log):
    return page


PORTALS = {
    "ccxp": {
        "id": "ccxp",
        "name": "校務資訊系統",
        "entry": CCXP_URL,
        "reach": _reach_direct,
        "account": "input[name='account']",
        "password": "input[name='passwd']",
        "captcha": "input[name='passwd2']",
        "captcha_img": "img[src*='auth_img.php']",
        "submit": "input[name='Submit']",
        "length": 6,
        "stay_host": "ccxp.nthu.edu.tw",
    },
    "elearn": {
        "id": "elearn",
        "name": "elearn 數位學習",
        "entry": ELEARN_URL,
        "reach": _reach_elearn,
        "account": "input[name='id']",
        "password": "input[name='password']",
        "captcha": "#captcha_code",
        "captcha_img": "#captcha_image",
        "submit": "button[name='action'][value='login']",
        "length": 4,
        "stay_host": "oauth.ccxp.nthu.edu.tw",
        "done_host": "elearn.nthu.edu.tw",
    },
    "eeclass": {
        "id": "eeclass",
        "name": "eeclass",
        "entry": EECLASS_URL,
        "reach": _reach_eeclass,
        "account": "input[name='id']",
        "password": "input[name='password']",
        "captcha": "#captcha_code",
        "captcha_img": "#captcha_image",
        "submit": "button[name='action'][value='login']",
        "length": 4,
        "stay_host": "oauth.ccxp.nthu.edu.tw",
        "done_host": "eeclass.nthu.edu.tw",
    },
    "library": {
        "id": "library",
        "name": "圖書館",
        "entry": LIBRARY_URL,
        "reach": _reach_direct,
        "account": "input[name='username']",
        "password": "input[name='password']",
        "captcha": "#checkNum",
        "captcha_img": "#captcha_img",
        "submit": "input[type='submit'][value='登入']",
        "length": 4,
        "stay_host": "idm.nthu.ust.edu.tw",
        "done_host": "lib.nthu.edu.tw",
    },
}


def _host(url: str) -> str:
    try:
        return url.split("/")[2]
    except Exception:
        return ""


def _logged_in(page, portal) -> bool:
    if page.is_closed() or _form_visible(page, portal):
        return False
    host = _host(page.url)
    if portal["id"] == "ccxp":
        if "ccxp.nthu.edu.tw" not in host:
            return False
        try:
            return bool(page.evaluate("() => (document.body && (document.body.innerText || '').trim().length > 80)"))
        except Exception:
            return False
    done = portal.get("done_host")
    return bool(done and done in host)


def _already_inside(page, portal) -> bool:
    """True when the entry page is already an authenticated session, before we type anything."""
    if _form_visible(page, portal):
        return False
    host = _host(page.url)
    if portal["id"] == "elearn":
        return "elearn.nthu.edu.tw" in host and page.locator("a[href*='logout'], a[href*='login/logout']").count() > 0
    if portal["id"] == "eeclass":
        return "eeclass.nthu.edu.tw" in host and page.locator("a[href*='logout'], a:has-text('登出')").count() > 0
    if portal["id"] == "library":
        return "lib.nthu.edu.tw" in host
    return False


class _Dialogs:
    def __init__(self):
        self.messages = []

    def handle(self, dialog):
        if dialog.type != "beforeunload":
            self.messages.append(dialog.message)
        dialog.accept()

    def clear(self):
        self.messages.clear()


def _error_text(page, dialogs: _Dialogs) -> str:
    parts = list(dialogs.messages)
    for selector in (
        "label[style*='color:red']",
        "label[style*='color: red']",
        ".text-danger-center",
        "b[style*='color:red']",
        ".errorlist",
        ".alert-danger",
    ):
        try:
            nodes = page.locator(selector)
            count = min(nodes.count(), 4)
        except Exception:
            continue
        for index in range(count):
            try:
                text = nodes.nth(index).inner_text(timeout=500).strip()
            except Exception:
                text = ""
            if text:
                parts.append(text)
    return " ".join(parts).strip()


def _failure_kind(text: str):
    if not text:
        return None
    if "驗證碼" in text:
        return "captcha"
    return "account"


def _fill(page, selector, value):
    field = page.locator(selector).first
    field.wait_for(state="visible", timeout=10000)
    field.fill(value)


def _launcher_page(context):
    """The tab that is already showing this app, so login can navigate it in place."""
    deadline = time.time() + 8
    while True:
        matches = []
        for page in context.pages:
            if page.is_closed():
                continue
            if ":8756" in (page.url or ""):
                matches.append(page)
        if matches:
            return matches[-1]
        if time.time() >= deadline:
            break
        time.sleep(0.25)
    raise RuntimeError("找不到原本的清大入口頁面，請先打開 http://127.0.0.1:8756/ 再按一次")


def _open_login(page, portal, log):
    if _form_visible(page, portal):
        return page
    log(f"用原本的頁面前往{portal['name']}")
    page.goto(portal["entry"], wait_until="domcontentloaded", timeout=30000)
    page = portal["reach"](page, log) or page
    if _already_inside(page, portal):
        return page
    try:
        page.wait_for_selector(portal["captcha"], timeout=15000)
    except PlaywrightTimeout:
        if _already_inside(page, portal):
            return page
        raise RuntimeError(f"找不到登入表單，目前頁面：{page.url}")
    return page


def _reload_form(page, portal, log):
    try:
        page.reload(wait_until="domcontentloaded", timeout=20000)
    except Exception:
        pass
    if not _form_visible(page, portal):
        return _open_login(page, portal, log)
    return page


def _outcome(page, portal, dialogs: _Dialogs):
    """Wait until the login form returns or the browser leaves the login host."""
    stay = portal["stay_host"]

    def settled(candidate):
        try:
            if candidate.is_closed():
                return False
            if dialogs.messages:
                return True
            if _form_visible(candidate, portal):
                return True
            host = _host(candidate.url)
            if host and stay not in host:
                return True
            if portal["id"] == "ccxp":
                try:
                    ready = candidate.evaluate(
                        "() => (document.body && (document.body.innerText || '').trim().length > 80)"
                    )
                except Exception:
                    ready = False
                if ready and not _form_visible(candidate, portal):
                    return True
        except Exception:
            return False
        return False

    landed = _wait_until(page, settled, timeout=12)
    if portal["id"] == "ccxp" and dialogs.messages and not _form_visible(landed, portal):
        try:
            landed.wait_for_selector(portal["password"], timeout=4000)
        except PlaywrightTimeout:
            pass
    return landed


def sign_in(context, portal_id: str, account: str, password: str, log) -> dict:
    portal = PORTALS[portal_id]
    dialogs = _Dialogs()
    bound = set()

    def use(target):
        if id(target) not in bound:
            target.on("dialog", dialogs.handle)
            target.set_default_timeout(20000)
            bound.add(id(target))
        return target

    page = use(_launcher_page(context))

    try:
        page = use(_open_login(page, portal, log))
        if _already_inside(page, portal):
            page.bring_to_front()
            log("這個系統已經是登入狀態")
            return {"status": "success", "message": f"{portal['name']}已經登入", "url": page.url}

        submits = 0
        refreshes = 0
        while submits < 3 and refreshes < 6:
            if not _form_visible(page, portal):
                page = use(_open_login(page, portal, log))
            if _already_inside(page, portal):
                page.bring_to_front()
                return {"status": "success", "message": f"{portal['name']}已經登入", "url": page.url}

            _fill(page, portal["account"], account)
            _fill(page, portal["password"], password)
            image = page.locator(portal["captcha_img"]).first
            image.wait_for(state="visible", timeout=10000)
            try:
                page.wait_for_function(
                    """selector => {
                        const el = document.querySelector(selector);
                        return !!(el && el.complete && el.naturalWidth > 10);
                    }""",
                    arg=portal["captcha_img"],
                    timeout=8000,
                )
            except Exception:
                pass
            code = read_captcha(image.screenshot(), portal["length"])
            if len(code) != portal["length"]:
                refreshes += 1
                log(f"驗證碼辨識不成（{code or '空白'}），換一張")
                page = use(_reload_form(page, portal, log))
                continue

            submits += 1
            log(f"第 {submits} 次登入，驗證碼辨識為 {code}")
            _fill(page, portal["captcha"], code)
            dialogs.clear()
            page.locator(portal["submit"]).first.click()
            page = use(_outcome(page, portal, dialogs))

            message = _error_text(page, dialogs)
            kind = _failure_kind(message)
            if kind == "account":
                page.bring_to_front()
                log(message)
                return {
                    "status": "error",
                    "message": f"登入沒有成功：{message}。已停止重試，請核對帳號密碼。",
                    "url": page.url,
                }
            if kind == "captcha" or dialogs.messages:
                log("驗證碼不對，準備重試")
                dialogs.clear()
                continue
            if _logged_in(page, portal) or (
                not _form_visible(page, portal) and portal["stay_host"] not in _host(page.url)
            ):
                page.bring_to_front()
                log(f"已進入{portal['name']}")
                return {"status": "success", "message": f"已進入{portal['name']}", "url": page.url}
            if _form_visible(page, portal):
                log("登入頁還在，準備重試")
                continue
            page.bring_to_front()
            return {
                "status": "needs_user",
                "message": "已送出登入，但沒有回到系統頁面。請看這個頁面。",
                "url": page.url,
            }

        if _form_visible(page, portal):
            _fill(page, portal["account"], account)
            _fill(page, portal["password"], password)
            try:
                page.locator(portal["captcha"]).first.fill("")
                page.locator(portal["captcha"]).first.focus()
            except Exception:
                pass
        page.bring_to_front()
        return {
            "status": "needs_user",
            "message": "驗證碼連續幾次都沒辨識成功。帳號密碼已填在這個頁面，請手動輸入驗證碼再按登入。",
            "url": page.url,
        }
    except Exception as exc:
        try:
            page.bring_to_front()
        except Exception:
            pass
        return {"status": "error", "message": f"登入中斷：{exc}", "url": getattr(page, "url", "")}


class BrowserSession:
    """The user's open Brave. Each portal is a new tab, not a new window."""

    def __init__(self):
        self.playwright = None
        self.browser = None
        self.context = None

    def _connected(self):
        if self.context is None:
            return False
        try:
            browser = self.context.browser
            return browser is not None and browser.is_connected()
        except Exception:
            return False

    def _reset(self):
        self.context = None
        self.browser = None

    def open(self):
        if self._connected():
            return
        self._reset()
        if self.playwright is None:
            self.playwright = sync_playwright().start()
        ensure_brave_tab_host()
        self.browser = self.playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        if not self.browser.contexts:
            raise RuntimeError("Brave 沒有可使用的視窗")
        self.context = self.browser.contexts[0]

    def sign_in(self, portal_id, account, password, log):
        last = None
        for attempt in range(2):
            try:
                self.open()
                return sign_in(self.context, portal_id, account, password, log)
            except Exception as exc:
                last = exc
                self._reset()
                if attempt == 1 or "has been closed" not in str(exc):
                    raise
        raise last


def check() -> int:
    """Open each login form, confirm the fields, and OCR the captcha. Does not submit."""
    print("載入驗證碼模型…")
    engines()
    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False,
            executable_path=str(browser_executable()),
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            ignore_https_errors=True,
            locale="zh-TW",
            viewport={"width": 1280, "height": 900},
        )
        try:
            for portal_id, portal in PORTALS.items():
                page = context.new_page()
                page.set_default_timeout(20000)
                notes = []
                try:
                    page.goto(portal["entry"], wait_until="domcontentloaded", timeout=30000)
                    page = portal["reach"](page, notes.append) or page
                    page.wait_for_selector(portal["captcha"], timeout=20000)
                    for selector in ("account", "password", "captcha", "captcha_img", "submit"):
                        if page.locator(portal[selector]).count() == 0:
                            raise RuntimeError(f"缺少欄位 {selector}")
                    code = read_captcha(page.locator(portal["captcha_img"]).first.screenshot(), portal["length"])
                    mark = "OK" if len(code) == portal["length"] else "WARN"
                    print(f"{mark} {portal_id} len={len(code)} code={code} url={page.url}")
                    for note in notes:
                        print("   ", note)
                except Exception as exc:
                    failures += 1
                    print(f"FAIL {portal_id} {exc} url={page.url}")
                    for note in notes:
                        print("   ", note)
                finally:
                    page.close()
        finally:
            context.close()
            browser.close()
    return 1 if failures else 0
