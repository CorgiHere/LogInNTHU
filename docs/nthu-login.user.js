// ==UserScript==
// @name         清大入口
// @namespace    https://github.com/CorgiHere/LogInNTHU
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @downloadURL  https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @description  在手機上用已存帳密登入清大系統，並辨識驗證碼
// @match        https://corgihere.github.io/LogInNTHU/*
// @match        https://corgihere.github.io/LogInNTHU/
// @match        https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/*
// @match        https://oauth.ccxp.nthu.edu.tw/*
// @match        https://elearn.nthu.edu.tw/*
// @match        https://eeclass.nthu.edu.tw/*
// @match        https://idm.nthu.ust.edu.tw/*
// @match        https://libsms.lib.nthu.edu.tw/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// @connect      tessdata.projectnaptha.com
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const CREDS = "nthu.creds";
  const JOB = "nthu.job";
  const ALERT = "nthu-alert";
  const EECLASS_OAUTH = "https://oauth.ccxp.nthu.edu.tw/v1.1/authorize.php?response_type=code&client_id=eeclass&redirect_uri=https%3A%2F%2Feeclass.nthu.edu.tw%2Fservice%2Foauth%2F&scope=lmsid+userid&state=&ui_locales=zh-TW";
  const TESS_JS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const TESS_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js";
  const TESS_CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js";
  const TESS_LANG = "https://tessdata.projectnaptha.com/4.0.0_fast";

  const FORMS = {
    ccxp: {
      account: "input[name='account']",
      password: "input[name='passwd']",
      captcha: "input[name='passwd2']",
      image: "img[src*='auth_img.php']",
      submit: "input[name='Submit']",
      length: 6,
    },
    oauth: {
      account: "input[name='id']",
      password: "input[name='password']",
      captcha: "#captcha_code",
      image: "#captcha_image",
      submit: "button[name='action'][value='login']",
      length: 4,
    },
    library: {
      account: "input[name='username']",
      password: "input[name='password']",
      captcha: "#checkNum",
      image: "#captcha_img",
      submit: "input[type='submit'][value='登入']",
      length: 4,
    },
  };

  function save(key, value) {
    const result = GM_setValue(key, JSON.stringify(value));
    return Promise.resolve(result);
  }

  async function load(key) {
    let raw = GM_getValue(key, "");
    if (raw && typeof raw.then === "function") raw = await raw;
    if (!raw || typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function hostKind() {
    const host = location.hostname;
    if (host === "www.ccxp.nthu.edu.tw") return "ccxp";
    if (host === "oauth.ccxp.nthu.edu.tw") return "oauth";
    if (host === "elearn.nthu.edu.tw") return "elearn";
    if (host === "eeclass.nthu.edu.tw") return "eeclass";
    if (host === "idm.nthu.ust.edu.tw") return "library";
    if (host === "libsms.lib.nthu.edu.tw") return "library-done";
    if (host === "corgihere.github.io" && location.pathname.indexOf("/LogInNTHU") === 0) return "launcher";
    return "";
  }

  function hookAlert() {
    try {
      const script = document.createElement("script");
      script.textContent = "window.alert=function(msg){try{sessionStorage.setItem('" + ALERT + "',String(msg||''))}catch(e){}};";
      document.documentElement.appendChild(script);
      script.remove();
    } catch (err) {}
  }

  function ready() {
    return new Promise((resolve) => {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      } else {
        resolve();
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function qs(selector) {
    return document.querySelector(selector);
  }

  function visible(el) {
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  async function waitFor(selector, ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const el = qs(selector);
      if (visible(el)) return el;
      await sleep(200);
    }
    return null;
  }

  function toast(text) {
    let bar = document.getElementById("nthu-login-toast");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "nthu-login-toast";
      bar.style.cssText = "position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top));z-index:2147483647;padding:12px 14px;border-radius:12px;background:#007aff;color:#fff;font:15px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,80,180,.25)";
      (document.body || document.documentElement).appendChild(bar);
    }
    bar.textContent = text;
  }

  function credsFor(portal, creds) {
    creds = creds || {};
    if (portal === "library") {
      return { id: (creds.libraryAccount || "").trim(), secret: creds.libraryPassword || "" };
    }
    return { id: (creds.account || "").trim(), secret: creds.password || "" };
  }

  function errorKind() {
    const alertMsg = sessionStorage.getItem(ALERT) || "";
    sessionStorage.removeItem(ALERT);
    const bits = [alertMsg];
    for (const el of document.querySelectorAll("label[style*='color:red'], label[style*='color: red'], .text-danger-center, b[style*='color:red']")) {
      bits.push(el.textContent || "");
    }
    const text = bits.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.includes("驗證碼")) return "captcha";
    return text;
  }

  function setField(el, value) {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      sleep(ms).then(() => {
        throw new Error("timeout");
      }),
    ]);
  }

  function imageURL(img) {
    return new URL(img.getAttribute("src"), location.href).href;
  }

  function gmText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("no-xhr"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: (resp) => resolve(resp.responseText || ""),
        onerror: () => reject(new Error("xhr")),
      });
    });
  }

  let workerPromise = null;

  async function worker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!globalThis.Tesseract) {
          const code = await gmText(TESS_JS);
          (0, eval)(code);
        }
        const engine = globalThis.Tesseract;
        if (!engine) throw new Error("no-ocr");
        const created = await engine.createWorker("eng", 1, {
          workerPath: TESS_WORKER,
          corePath: TESS_CORE,
          langPath: TESS_LANG,
        });
        await created.setParameters({ tessedit_char_whitelist: "0123456789" });
        return created;
      })();
    }
    return workerPromise;
  }

  async function readCaptcha(img, length) {
    const engine = await worker();
    const src = imageURL(img);
    const votes = [];
    for (const height of [80, 160]) {
      const data = await draw(src, height);
      const result = await engine.recognize(data);
      const digits = ((result && result.data && result.data.text) || "").replace(/\D/g, "");
      if (digits) votes.push(digits);
      if (digits.length === length) return digits;
    }
    const exact = votes.filter((item) => item.length === length);
    return (exact[0] || votes[0] || "");
  }

  function draw(src, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = height / img.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("image"));
      img.src = src;
    });
  }

  async function clickThrough(kind) {
    if (kind === "library-done") {
      save(JOB, null);
      toast("已經登入");
      return;
    }
    if (kind === "elearn") {
      if (qs("a[href*='logout']") && !qs("a[href*='auth/oauth2/login.php']")) {
        save(JOB, null);
        toast("已經登入");
        return;
      }
      toast("正在打開 elearn 登入");
      const link = await waitFor("a[href*='auth/oauth2/login.php']", 6000);
      if (link) link.click();
      else location.assign("https://elearn.nthu.edu.tw/auth/oauth2/login.php?id=5&wantsurl=/");
      return;
    }
    if (kind === "eeclass") {
      toast("正在打開 eeclass 登入");
      const link = await waitFor("a[href*='oauthRedir']", 5000);
      if (link) link.click();
      else location.assign(EECLASS_OAUTH);
    }
  }

  async function signIn(job) {
    const kind = hostKind();
    const formKind = kind === "ccxp" ? "ccxp" : kind === "library" ? "library" : kind === "oauth" ? "oauth" : "";
    if (!formKind) {
      await clickThrough(kind);
      return;
    }
    if (formKind === "oauth" && job.portal !== "elearn" && job.portal !== "eeclass") return;
    if (formKind === "ccxp" && job.portal !== "ccxp") return;
    if (formKind === "library" && job.portal !== "library") return;

    const form = FORMS[formKind];
    toast("正在填入帳號");
    const captcha = await waitFor(form.captcha, 8000);
    if (!captcha) {
      await save(JOB, { until: 0 });
      toast("已進入系統");
      return;
    }
    const creds = credsFor(job.portal, await load(CREDS));
    if (!creds.id || !creds.secret) {
      await save(JOB, { until: 0 });
      toast("請先回清大入口填寫帳號");
      return;
    }
    const failure = errorKind();
    if (failure && failure !== "captcha") {
      await save(JOB, { until: 0 });
      toast(failure);
      return;
    }
    setField(qs(form.account), creds.id);
    setField(qs(form.password), creds.secret);
    if ((job.refreshes || 0) >= 2 || (job.submits || 0) >= 3) {
      await save(JOB, { until: 0 });
      captcha.focus();
      toast("驗證碼請手動輸入後按登入");
      return;
    }
    const img = await waitFor(form.image, 8000);
    if (!img) {
      captcha.focus();
      toast("找不到驗證碼圖片，請手動輸入");
      return;
    }
    toast("正在辨識驗證碼");
    let code = "";
    try {
      code = await withTimeout(readCaptcha(img, form.length), 8000);
    } catch (err) {
      await save(JOB, { until: 0 });
      captcha.focus();
      toast("請手動輸入驗證碼後按登入");
      return;
    }
    if (code.length !== form.length) {
      job.refreshes = (job.refreshes || 0) + 1;
      await save(JOB, job);
      toast("換一張驗證碼");
      location.reload();
      return;
    }
    setField(captcha, code);
    job.submits = (job.submits || 0) + 1;
    await save(JOB, job);
    toast("第 " + job.submits + " 次登入，驗證碼 " + code);
    const button = qs(form.submit);
    if (button) button.click();
  }

  function bindLauncher() {
    document.documentElement.dataset.nthuHelper = "1";
    document.dispatchEvent(new Event("nthu-helper"));
    const snapshot = () => ({
      account: ((qs("#account") && qs("#account").value) || "").trim(),
      password: (qs("#password") && qs("#password").value) || "",
      libraryAccount: ((qs("#library-account") && qs("#library-account").value) || "").trim(),
      libraryPassword: (qs("#library-password") && qs("#library-password").value) || "",
    });
    document.addEventListener("input", () => { save(CREDS, snapshot()); }, true);
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest("a[data-portal]");
      if (!link || !link.href) return;
      const portal = link.dataset.portal;
      const creds = snapshot();
      const picked = credsFor(portal, creds);
      if (!picked.id || !picked.secret) return;
      event.preventDefault();
      event.stopPropagation();
      const href = link.href;
      Promise.all([
        save(CREDS, creds),
        save(JOB, { portal: portal, until: Date.now() + 120000, submits: 0, refreshes: 0 }),
      ]).then(() => sleep(500)).then(() => {
        location.assign(href);
      }).catch(() => {
        location.assign(href);
      });
    }, true);
    save(CREDS, snapshot());
  }

  if (hostKind() === "ccxp") hookAlert();

  ready().then(async () => {
    try {
      if (hostKind() === "launcher") {
        bindLauncher();
        return;
      }
      const job = await load(JOB);
      if (!job || !job.until || job.until < Date.now()) {
        if ((document.referrer || "").indexOf("corgihere.github.io") !== -1) {
          toast("沒有讀到已存帳號，請回清大入口再點一次");
        }
        return;
      }
      await signIn(job);
    } catch (err) {
      toast("請手動輸入驗證碼後按登入");
    }
  });
})();
