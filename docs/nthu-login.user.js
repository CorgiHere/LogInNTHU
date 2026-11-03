// ==UserScript==
// @name         清大入口
// @namespace    https://github.com/CorgiHere/LogInNTHU
// @version      1.8.1
// @updateURL    https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @downloadURL  https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js
// @description  手機自己輸入驗證碼，電腦會辨識驗證碼並登入
// @match        http://127.0.0.1:8756/*
// @match        http://localhost:8756/*
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
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// @connect      tessdata.projectnaptha.com
// @connect      127.0.0.1
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const CREDS = "nthu.creds";
  const JOB = "nthu.job";
  const ALERT = "nthu-alert";
  const EECLASS_OAUTH = "https://oauth.ccxp.nthu.edu.tw/v1.1/authorize.php?response_type=code&client_id=eeclass&redirect_uri=https%3A%2F%2Feeclass.nthu.edu.tw%2Fservice%2Foauth%2F&scope=lmsid+userid&state=&ui_locales=zh-TW";
  const ENTRIES = {
    ccxp: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/",
    elearn: "https://elearn.nthu.edu.tw/auth/oauth2/login.php?id=5&wantsurl=/",
    eeclass: EECLASS_OAUTH,
    library: "https://idm.nthu.ust.edu.tw/sso/886UST_NTHU/oidc/login/?next=/openid/886UST_NTHU/authorize/%3Fclient_id%3D227897%26response_type%3Dcode%26redirect_uri%3Dhttps%3A//libsms.lib.nthu.edu.tw/openidcallback.aspx%26state%3DRWD%26scope%3Dopenid",
  };
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
    if ((host === "127.0.0.1" || host === "localhost") && location.port === "8756") return "launcher";
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
    if (hostKind() !== "launcher") return;
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

  function onPhone() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
    return navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua);
  }

  function gmText(url) {
    const details = { method: "GET", url: url, timeout: 12000, responseType: "text" };
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") {
      return Promise.resolve(GM.xmlHttpRequest(details)).then((resp) => (resp && (resp.responseText || resp.response)) || "");
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest(Object.assign({}, details, {
          onload: (resp) => resolve((resp && resp.responseText) || ""),
          onerror: () => reject(new Error("xhr")),
          ontimeout: () => reject(new Error("xhr")),
        }));
      });
    }
    return Promise.reject(new Error("no-xhr"));
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
        await created.setParameters({
          tessedit_char_whitelist: "0123456789",
          tessedit_pageseg_mode: "7",
        });
        return created;
      })();
    }
    return workerPromise;
  }

  function drawElement(img, height) {
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    if (!nw || !nh) return "";
    const scale = height / nh;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(nw * scale));
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  function captureInPage(img, height) {
    const token = "nthu" + Math.random().toString(36).slice(2);
    img.setAttribute("data-nthu-cap", token);
    const script = document.createElement("script");
    script.textContent = "(function(){var img=document.querySelector('[data-nthu-cap=\"" + token + "\"]');var box=document.createElement('textarea');box.id='" + token + "';box.setAttribute('aria-hidden','true');box.style.cssText='position:fixed;left:-9999px;top:0;width:1px;height:1px';document.documentElement.appendChild(box);if(!img)return;var nh=img.naturalHeight||img.height,nw=img.naturalWidth||img.width;if(!nh||!nw)return;var s=" + height + "/nh,c=document.createElement('canvas');c.width=Math.max(1,Math.round(nw*s));c.height=" + height + ";var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);try{box.value=c.toDataURL('image/png')}catch(e){}})();";
    document.documentElement.appendChild(script);
    script.remove();
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const box = document.getElementById(token);
        if (box && box.value) {
          const data = box.value;
          box.remove();
          img.removeAttribute("data-nthu-cap");
          resolve(data);
          return;
        }
        if (Date.now() - start > 1200) {
          if (box) box.remove();
          img.removeAttribute("data-nthu-cap");
          resolve("");
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  async function capture(img, height) {
    if (!img.naturalWidth) {
      await new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
        setTimeout(done, 1500);
      });
    }
    const fromPage = await captureInPage(img, height);
    if (fromPage) return fromPage;
    try {
      return drawElement(img, height);
    } catch (err) {
      return "";
    }
  }

  function gmPost(url, body) {
    const details = {
      method: "POST",
      url: url,
      data: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      timeout: 8000,
    };
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") {
      return Promise.resolve(GM.xmlHttpRequest(details)).then((resp) => (resp && (resp.responseText || resp.response)) || "");
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest(Object.assign({}, details, {
          onload: (resp) => resolve((resp && resp.responseText) || ""),
          onerror: () => reject(new Error("xhr")),
          ontimeout: () => reject(new Error("xhr")),
        }));
      });
    }
    return Promise.reject(new Error("no-xhr"));
  }

  async function localCode(img, length) {
    const shot = await capture(img, 120);
    if (!shot) throw new Error("image");
    const parsed = JSON.parse(await gmPost("http://127.0.0.1:8756/api/ocr", { image: shot, length: length }));
    return String((parsed && parsed.code) || "").replace(/\D/g, "");
  }

  async function readCaptcha(img, length) {
    try {
      const local = await localCode(img, length);
      if (local.length === length) return local;
    } catch (err) {}
    const engine = await worker();
    const votes = [];
    for (const height of [160, 280]) {
      const data = await capture(img, height);
      if (!data) continue;
      const result = await engine.recognize(data);
      const digits = ((result && result.data && result.data.text) || "").replace(/\D/g, "");
      if (digits) votes.push(digits);
    }
    const exact = votes.filter((item) => item.length === length);
    if (!exact.length) return votes[0] || "";
    exact.sort((a, b) => exact.filter((item) => item === b).length - exact.filter((item) => item === a).length);
    return exact[0];
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
    if (onPhone()) {
      prepareCaptcha(captcha);
      toast(failure === "captcha" ? "驗證碼錯誤，請再輸入一次" : "帳號已填好，請輸入驗證碼後按登入");
      return;
    }
    if ((job.refreshes || 0) >= 2 || (job.submits || 0) >= 3) {
      await save(JOB, { until: 0 });
      prepareCaptcha(captcha);
      toast("驗證碼請手動輸入後按登入");
      return;
    }
    const img = await waitFor(form.image, 8000);
    if (!img) {
      prepareCaptcha(captcha);
      toast("找不到驗證碼圖片，請手動輸入");
      return;
    }
    toast("正在辨識驗證碼");
    let code = "";
    try {
      code = await withTimeout(readCaptcha(img, form.length), 15000);
    } catch (err) {
      await save(JOB, { until: 0 });
      prepareCaptcha(captcha);
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
    setField(captcha, code, true);
    await sleep(80);
    if ((captcha.value || "").replace(/\D/g, "") !== code) {
      await save(JOB, { until: 0 });
      prepareCaptcha(captcha);
      toast("驗證碼沒有寫進欄位，請手動輸入 " + code);
      return;
    }
    job.submits = (job.submits || 0) + 1;
    await save(JOB, job);
    toast("第 " + job.submits + " 次登入，驗證碼 " + code);
    const button = qs(form.submit);
    if (button) button.click();
  }

  async function takeHandoff() {
    try {
      const text = await gmText("http://127.0.0.1:8756/api/handoff");
      const data = JSON.parse(text || "");
      if (!data || !data.ok || !data.job || !data.job.portal) return null;
      const job = data.job;
      await save(CREDS, {
        account: job.account || "",
        password: job.password || "",
        libraryAccount: job.libraryAccount || "",
        libraryPassword: job.libraryPassword || "",
      });
      const saved = { portal: job.portal, until: Date.now() + 120000, submits: 0, refreshes: 0 };
      await save(JOB, saved);
      return saved;
    } catch (err) {
      return null;
    }
  }

  function bindLauncher() {
    document.documentElement.dataset.nthuHelper = "1.8.1";
    document.dispatchEvent(new Event("nthu-helper"));
    const snapshot = () => ({
      account: ((qs("#account") && qs("#account").value) || "").trim(),
      password: (qs("#password") && qs("#password").value) || "",
      libraryAccount: ((qs("#library-account") && qs("#library-account").value) || "").trim(),
      libraryPassword: (qs("#library-password") && qs("#library-password").value) || "",
    });
    document.addEventListener("input", () => { save(CREDS, snapshot()).catch(() => {}); }, true);
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest("[data-portal]");
      if (!link) return;
      const portal = link.dataset.portal;
      const href = link.href || ENTRIES[portal];
      if (!href) return;
      const creds = snapshot();
      const picked = credsFor(portal, creds);
      if (!picked.id || !picked.secret) return;
      event.preventDefault();
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

  function hideNode(el) {
    if (el) el.setAttribute("hidden", "");
  }

  function armCcxp() {
    if (!onPhone() || hostKind() !== "ccxp") return;
    const style = document.createElement("style");
    style.id = "nthu-ccxp-simple";
    style.textContent = "html.nthu-ccxp-pending body{visibility:hidden}html.nthu-ccxp-simple,html.nthu-ccxp-simple body{background:#fff!important}html.nthu-ccxp-simple body{visibility:visible;margin:0}html.nthu-ccxp-simple [hidden]{display:none!important}html.nthu-ccxp-simple img[src*='login_top']{width:100%!important;height:auto!important}html.nthu-ccxp-simple form[name='form1']{box-sizing:border-box;padding:4px 20px 32px;max-width:430px}html.nthu-ccxp-simple input.inputtext{display:block;width:100%!important;box-sizing:border-box;font-size:17px!important;margin:8px 0 16px!important;padding:10px 2px}html.nthu-ccxp-simple input.button{min-width:96px;min-height:44px}html.nthu-ccxp-simple img[src*='auth_img']{vertical-align:middle;margin:8px 8px 12px 0}";
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.classList.add("nthu-ccxp-pending");
    setTimeout(() => document.documentElement.classList.remove("nthu-ccxp-pending"), 2000);
  }

  function simplifyCcxp() {
    if (!onPhone() || hostKind() !== "ccxp") return;
    const form = document.querySelector("form[name='form1']");
    const captcha = form && form.querySelector("input[name='passwd2']");
    document.documentElement.classList.remove("nthu-ccxp-pending");
    if (!captcha) {
      document.documentElement.classList.remove("nthu-ccxp-simple");
      const viewport = document.querySelector("meta[data-nthu='1']");
      if (viewport) viewport.remove();
      return;
    }
    document.documentElement.classList.add("nthu-ccxp-simple");
    if (!document.querySelector("meta[name='viewport']")) {
      const meta = document.createElement("meta");
      meta.name = "viewport";
      meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
      meta.setAttribute("data-nthu", "1");
      (document.head || document.documentElement).appendChild(meta);
    }
    for (const child of Array.from(document.body.children)) {
      if (child.contains(form) || child.id === "nthu-login-toast" || child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
      hideNode(child);
    }
    const cell = form.closest("td");
    const row = cell && cell.parentElement;
    if (row) {
      for (const td of Array.from(row.children)) {
        if (td !== cell) hideNode(td);
      }
      cell.style.width = "100%";
    }
    form.querySelectorAll("a[href*='punch.ccxp'], a[href*='sso.nd.nthu.edu.tw']").forEach(hideNode);
    hideNode(form.querySelector("table[bordercolor='red']"));
    const scope = cell || document.body;
    scope.querySelectorAll("table").forEach((table) => {
      if (form.contains(table) || table.contains(form)) return;
      if (table.querySelector("img[src*='login_top']")) return;
      hideNode(table);
    });
    hideNode(scope.querySelector("#twcaseal"));
    let box = form.parentElement;
    while (box && box !== document.body) {
      if (box.style && /login_mid/.test(box.style.backgroundImage || "")) box.style.backgroundImage = "none";
      box = box.parentElement;
    }
  }

  if (hostKind() === "launcher") document.documentElement.dataset.nthuHelper = "1.8.1";
  if (hostKind() === "ccxp") hookAlert();
  armCcxp();

  ready().then(async () => {
    try {
      simplifyCcxp();
      if (hostKind() === "launcher") {
        bindLauncher();
        return;
      }
      let job = await load(JOB);
      if (!job || !job.until || job.until < Date.now()) job = await takeHandoff();
      if (!job || !job.until || job.until < Date.now()) {
        const ref = document.referrer || "";
        if (ref.indexOf("corgihere.github.io") !== -1 || ref.indexOf(":8756") !== -1) {
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
