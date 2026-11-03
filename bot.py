# -*- coding: utf-8 -*-
"""Open a real Chrome window and sign in to the user's own NTHU portals."""

import io
import time
from collections import Counter
from pathlib import Path

import ddddocr
from PIL import Image
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PROFILE_DIR = ROOT / ".browser-profile"

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
    global _ENGINES
    if _ENGINES is None:
        loaded = [
            ddddocr.DdddOcr(show_ad=False),
            ddddocr.DdddOcr(show_ad=False, beta=True),
        ]
        for engine in loaded:
            engine.set_ranges("0123456789")
        _ENGINES = loaded
    return _ENGINES


def _resample(raw: bytes, height: int) -> bytes:
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    width = max(1, int(image.width * (height / image.height)))
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def read_captcha(raw: bytes, length: int) -> str:
    """Vote across two digit models. Screenshots are scaled back to captcha size first."""
    try:
        base = _resample(raw, 80)
    except Exception:
        base = raw
    votes = []
    blobs = [base]
    try:
        blobs.append(_resample(base, 240))
    except Exception:
        pass
    for blob in blobs:
        for engine in engines():
            try:
                text = engine.classification(blob, png_fix=True)
            except Exception:
                text = ""
            digits = "".join(ch for ch in str(text) if ch.isdigit())
            if digits:
                votes.append(digits)
    exact = [item for item in votes if len(item) == length]
    pool = exact or votes
    if not pool:
        return ""
    return Counter(pool).most_common(1)[0][0]


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


def _open_login(page, portal, log):
    if _form_visible(page, portal):
        return page
    log(f"開啟{portal['name']}")
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

    blanks = [p for p in context.pages if not p.is_closed() and p.url in ("about:blank", "chrome://newtab/")]
    page = use(blanks[0] if blanks else context.new_page())

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
                "message": "已送出登入，但沒有回到系統頁面。請看開啟的 Chrome 視窗。",
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
            "message": "驗證碼連續幾次都沒辨識成功。帳號密碼已填進開啟的視窗，請手動輸入驗證碼再按登入。",
            "url": page.url,
        }
    except Exception as exc:
        try:
            page.bring_to_front()
        except Exception:
            pass
        return {"status": "error", "message": f"登入中斷：{exc}", "url": getattr(page, "url", "")}


class BrowserSession:
    """One headed Chrome, reused so each portal stays open in its own tab."""

    def __init__(self):
        self.playwright = None
        self.context = None

    def open(self):
        if self.context is not None:
            try:
                _ = self.context.pages
                return
            except Exception:
                self.context = None
        if self.playwright is None:
            self.playwright = sync_playwright().start()
        PROFILE_DIR.mkdir(exist_ok=True)
        self.context = self.playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            channel="chrome",
            headless=False,
            no_viewport=True,
            ignore_https_errors=True,
            locale="zh-TW",
            ignore_default_args=["--enable-automation"],
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
        )

    def sign_in(self, portal_id, account, password, log):
        self.open()
        return sign_in(self.context, portal_id, account, password, log)


def check() -> int:
    """Open each login form, confirm the fields, and OCR the captcha. Does not submit."""
    print("載入驗證碼模型…")
    engines()
    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False,
            channel="chrome",
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
