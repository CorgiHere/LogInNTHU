// ==UserScript==
// @name         清大入口
// @namespace    https://github.com/CorgiHere/LogInNTHU
// @version      1.4.0
// @updateURL    https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @downloadURL  https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @description  在手機上填入已存帳密，驗證碼由自己輸入
// @match        https://corgihere.github.io/LogInNTHU/*
// @match        https://corgihere.github.io/LogInNTHU/
// @match        https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/*
// @match        https://oauth.ccxp.nthu.edu.tw/*
// @match        https://elearn.nthu.edu.tw/*
// @match        https://eeclass.nthu.edu.tw/*
// @match        https://idm.nthu.ust.edu.tw/*
// @match        https://libsms.lib.nthu.edu.tw/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_setValue
// @grant        GM_getValue
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const CREDS = "nthu.creds";
  const JOB = "nthu.job";
  const ALERT = "nthu-alert";
  const EECLASS_OAUTH = "https://oauth.ccxp.nthu.edu.tw/v1.1/authorize.php?response_type=code&client_id=eeclass&redirect_uri=https%3A%2F%2Feeclass.nthu.edu.tw%2Fservice%2Foauth%2F&scope=lmsid+userid&state=&ui_locales=zh-TW";

  const FORMS = {
    ccxp: {
      account: "input[name='account']",
      password: "input[name='passwd']",
      captcha: "input[name='passwd2']",
    },
    oauth: {
      account: "input[name='id']",
      password: "input[name='password']",
      captcha: "#captcha_code",
    },
    library: {
      account: "input[name='username']",
      password: "input[name='password']",
      captcha: "#checkNum",
    },
  };

  function save(key, value) {
    try {
      if (typeof GM !== "undefined" && GM && typeof GM.setValue === "function") {
        return Promise.resolve(GM.setValue(key, value));
      }
      if (typeof GM_setValue === "function") {
        return Promise.resolve(GM_setValue(key, value));
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.reject(new Error("no-storage"));
  }

  async function load(key) {
    try {
      let raw = null;
      if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
        raw = await GM.getValue(key, null);
      } else if (typeof GM_getValue === "function") {
        raw = GM_getValue(key, null);
        if (raw && typeof raw.then === "function") raw = await raw;
      }
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch (err) {
          return null;
        }
      }
      if (!raw || typeof raw !== "object") return null;
      return raw;
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

  function setField(el, value, numeric) {
    if (!el) return;
    const text = String(value);
    const token = "nthu" + Math.random().toString(36).slice(2);
    el.setAttribute("data-nthu-field", token);
    if (numeric && (el.type === "number" || el.type === "tel")) {
      el.type = "text";
      el.setAttribute("inputmode", "numeric");
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const script = document.createElement("script");
    const literal = JSON.stringify(text).replace(/</g, "\\u003c");
    script.textContent = "(function(){var el=document.querySelector('[data-nthu-field=\"" + token + "\"]');if(!el)return;" +
      (numeric ? "if(el.type==='number'||el.type==='tel'){el.type='text';el.setAttribute('inputmode','numeric');}" : "") +
      "var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');var v=" + literal + ";" +
      "if(d&&d.set)d.set.call(el,v);else el.value=v;" +
      "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})();";
    document.documentElement.appendChild(script);
    script.remove();
    el.removeAttribute("data-nthu-field");
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      sleep(ms).then(() => {
        throw new Error("timeout");
      }),
    ]);
  }

  function prepareCaptcha(el) {
    if (!el) return;
    if (el.type === "number" || el.type === "tel") {
      el.type = "text";
      el.setAttribute("inputmode", "numeric");
    }
    try {
      el.scrollIntoView({ block: "center" });
    } catch (err) {}
    el.focus();
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
    prepareCaptcha(captcha);
    toast(failure === "captcha" ? "驗證碼錯誤，請再輸入一次" : "帳號已填好，請輸入驗證碼後按登入");
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
    document.addEventListener("input", () => { save(CREDS, snapshot()).catch(() => {}); }, true);
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest("a[data-portal]");
      if (!link || !link.href) return;
      const portal = link.dataset.portal;
      const creds = snapshot();
      const picked = credsFor(portal, creds);
      if (!picked.id || !picked.secret) return;
      event.preventDefault();
      const href = link.href;
      toast("正在前往…");
      withTimeout(Promise.all([
        save(CREDS, creds),
        save(JOB, { portal: portal, until: Date.now() + 120000, submits: 0, refreshes: 0 }),
      ]), 4000).then(() => sleep(200)).then(() => {
        location.assign(href);
      }).catch(() => {
        toast("帳號沒有存好，請再點一次");
      });
    }, true);
    save(CREDS, snapshot()).catch(() => {});
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
      if (hostKind() === "launcher") {
        toast("登入輔助沒有啟動完成，請重新安裝");
        return;
      }
      toast("請手動輸入驗證碼後按登入");
    }
  });
})();
