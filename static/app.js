const account = document.querySelector("#account");
const password = document.querySelector("#password");
const libraryAccount = document.querySelector("#library-account");
const libraryPassword = document.querySelector("#library-password");
const savedSchool = document.querySelector("#saved-school");
const savedLibrary = document.querySelector("#saved-library");
const settingsButton = document.querySelector("#settings");
const settingsPanel = document.querySelector("#settings-panel");
const status = document.querySelector("#status");
const log = document.querySelector("#log");
const portals = [...document.querySelectorAll(".portal")];

const ENTRIES = {
  ccxp: "https://www.ccxp.nthu.edu.tw/ccxp/INQUIRE/",
  elearn: "https://elearn.nthu.edu.tw/auth/oauth2/login.php?id=5&wantsurl=/",
  eeclass: "https://oauth.ccxp.nthu.edu.tw/v1.1/authorize.php?response_type=code&client_id=eeclass&redirect_uri=https%3A%2F%2Feeclass.nthu.edu.tw%2Fservice%2Foauth%2F&scope=lmsid+userid&state=&ui_locales=zh-TW",
  library: "https://idm.nthu.ust.edu.tw/sso/886UST_NTHU/oidc/login/?next=/openid/886UST_NTHU/authorize/%3Fclient_id%3D227897%26response_type%3Dcode%26redirect_uri%3Dhttps%3A//libsms.lib.nthu.edu.tw/openidcallback.aspx%26state%3DRWD%26scope%3Dopenid",
};

const KEY_ID = "nthu.account";
const KEY_PW = "nthu.password";
const KEY_LIB_ID = "nthu.library.account";
const KEY_LIB_PW = "nthu.library.password";

account.value = localStorage.getItem(KEY_ID) || "";
password.value = localStorage.getItem(KEY_PW) || "";
libraryAccount.value = localStorage.getItem(KEY_LIB_ID) || "";
libraryPassword.value = localStorage.getItem(KEY_LIB_PW) || "";

function markSaved(node, on) {
  node.textContent = on ? "已存於這台瀏覽器" : "尚未儲存";
  node.classList.toggle("on", on);
}

function persist() {
  const id = account.value.trim();
  const libraryId = libraryAccount.value.trim();
  localStorage.setItem(KEY_ID, id);
  localStorage.setItem(KEY_PW, password.value);
  localStorage.setItem(KEY_LIB_ID, libraryId);
  localStorage.setItem(KEY_LIB_PW, libraryPassword.value);
  markSaved(savedSchool, Boolean(id && password.value));
  markSaved(savedLibrary, Boolean(libraryId && libraryPassword.value));
}

function setStatus(text, kind) {
  status.textContent = text;
  status.className = "status" + (kind ? " " + kind : "");
}

function setLog(lines) {
  log.replaceChildren();
  for (const line of lines || []) {
    const item = document.createElement("li");
    item.textContent = line;
    log.appendChild(item);
  }
}

function setBusy(busy) {
  for (const button of portals) button.disabled = busy;
}

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
  settingsButton.textContent = open ? "完成" : "設定";
}

settingsButton.addEventListener("click", () => {
  setSettingsOpen(settingsPanel.hidden);
});

for (const field of [account, password, libraryAccount, libraryPassword]) {
  field.addEventListener("input", persist);
}
persist();

function bindToggle(button, field) {
  button.addEventListener("click", () => {
    const show = field.type === "password";
    field.type = show ? "text" : "password";
    button.textContent = show ? "隱藏" : "顯示";
  });
}

bindToggle(document.querySelector("#toggle-school"), password);
bindToggle(document.querySelector("#toggle-library"), libraryPassword);

document.querySelector("#clear-school").addEventListener("click", () => {
  localStorage.removeItem(KEY_ID);
  localStorage.removeItem(KEY_PW);
  account.value = "";
  password.value = "";
  persist();
  setStatus("已清除校務帳號。");
});

document.querySelector("#clear-library").addEventListener("click", () => {
  localStorage.removeItem(KEY_LIB_ID);
  localStorage.removeItem(KEY_LIB_PW);
  libraryAccount.value = "";
  libraryPassword.value = "";
  persist();
  setStatus("已清除圖書館帳號。");
});

async function poll(id) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 180000) {
      setStatus("等太久了。請看這個頁面。", "warn");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    const res = await fetch("/api/jobs/" + id);
    const data = await res.json();
    if (!data.ok) {
      setStatus(data.error || "狀態讀取失敗", "bad");
      return;
    }
    const job = data.job;
    setLog(job.log);
    if (job.status === "success") {
      setStatus(job.message + "。", "ok");
      return;
    }
    if (job.status === "needs_user") {
      setStatus(job.message, "warn");
      return;
    }
    if (job.status === "error") {
      setStatus(job.message, "bad");
      return;
    }
    setStatus(job.message || "登入中…");
  }
}

for (const button of portals) {
  button.addEventListener("click", async () => {
    persist();
    const library = button.dataset.portal === "library";
    const id = (library ? libraryAccount.value : account.value).trim();
    const secret = library ? libraryPassword.value : password.value;
    if (!id || !secret) {
      setSettingsOpen(true);
      setStatus(library ? "請先填寫圖書館帳號和密碼。" : "請先填寫校務帳號和密碼。", "warn");
      (library ? libraryAccount : account).focus();
      return;
    }
    if (document.documentElement.dataset.nthuHelper !== "1.8.1") {
      setStatus("請在接下來的頁面按安裝或更新。完成後回到上一頁，再點一次。", "warn");
      location.assign("/nthu-login.user.js");
      return;
    }
    setStatus("正在前往登入頁…");
    try {
      await fetch("/api/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portal: button.dataset.portal,
          account: account.value.trim(),
          password: password.value,
          libraryAccount: libraryAccount.value.trim(),
          libraryPassword: libraryPassword.value,
        }),
      });
    } catch (err) {}
  });
}
