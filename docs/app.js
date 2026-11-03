const account = document.querySelector("#account");
const password = document.querySelector("#password");
const libraryAccount = document.querySelector("#library-account");
const libraryPassword = document.querySelector("#library-password");
const savedSchool = document.querySelector("#saved-school");
const savedLibrary = document.querySelector("#saved-library");
const settingsButton = document.querySelector("#settings");
const settingsPanel = document.querySelector("#settings-panel");
const status = document.querySelector("#status");
const setup = document.querySelector("#setup");
const helperState = document.querySelector("#helper-state");

const KEY_ID = "nthu.account";
const KEY_PW = "nthu.password";
const KEY_LIB_ID = "nthu.library.account";
const KEY_LIB_PW = "nthu.library.password";

account.value = localStorage.getItem(KEY_ID) || "";
password.value = localStorage.getItem(KEY_PW) || "";
libraryAccount.value = localStorage.getItem(KEY_LIB_ID) || "";
libraryPassword.value = localStorage.getItem(KEY_LIB_PW) || "";

function markSaved(node, on) {
  node.textContent = on ? "已存於這支手機" : "尚未儲存";
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

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
  settingsButton.textContent = open ? "完成" : "設定";
}

function credentialsFor(portal) {
  if (portal === "library") {
    return { id: libraryAccount.value.trim(), secret: libraryPassword.value };
  }
  return { id: account.value.trim(), secret: password.value };
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

for (const link of document.querySelectorAll(".portal")) {
  link.addEventListener("click", (event) => {
    const library = link.dataset.portal === "library";
    const creds = credentialsFor(link.dataset.portal);
    if (!creds.id || !creds.secret) {
      event.preventDefault();
      setSettingsOpen(true);
      settingsPanel.scrollIntoView({ block: "start" });
      setStatus(library ? "請先填寫圖書館帳號和密碼。" : "請先填寫校務帳號和密碼。", "warn");
      (library ? libraryAccount : account).focus();
      return;
    }
    setStatus("正在前往…");
  });
}

const SCRIPT_URL = "https://raw.githubusercontent.com/CorgiHere/LogInNTHU/main/docs/nthu-login.user.js";
const PAGE_URL = "https://corgihere.github.io/LogInNTHU/";
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua);
const isAndroid = /Android/.test(ua);

function fillSetup() {
  const box = document.querySelector("#setup-steps");
  const title = document.querySelector("#setup-title");
  box.replaceChildren();
  let rows;
  if (isIOS) {
    title.textContent = "iPhone 的 Chrome 不能裝輔助";
    rows = [
      { n: "1", text: "登入輔助只能裝在 Safari，Chrome 裝不了" },
      { n: "2", text: "複製網址，改用 Safari 打開這個頁面", href: PAGE_URL, copy: true },
      { n: "3", text: "在 App Store 安裝免費的 Userscripts" },
      { n: "4", text: "到「設定 → Safari → 擴充功能」打開它，並允許所有網站" },
      { n: "5", text: "在 Safari 打開安裝連結，點擴充圖示後按安裝", href: SCRIPT_URL },
      { n: "6", text: "之後都用 Safari 打開清大入口。登入狀態會留在 Safari" },
    ];
  } else if (isAndroid) {
    title.textContent = "Android 的 Chrome 不能裝輔助";
    rows = [
      { n: "1", text: "請改用 Firefox 瀏覽器" },
      { n: "2", text: "在 Firefox 安裝 Tampermonkey", href: "https://addons.mozilla.org/firefox/addon/tampermonkey/" },
      { n: "3", text: "再用 Firefox 打開安裝連結，按安裝", href: SCRIPT_URL },
      { n: "4", text: "用 Firefox 回到這頁，按「設定」填帳號" },
    ];
  } else {
    title.textContent = "在 Chrome 使用";
    rows = [
      { n: "1", text: "安裝 Tampermonkey 擴充功能", href: "https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo" },
      { n: "2", text: "打開安裝連結，按安裝登入輔助", href: SCRIPT_URL },
      { n: "3", text: "回到這頁按「設定」填帳號，再點要進去的系統" },
    ];
  }
  for (const item of rows) {
    const row = document.createElement(item.href ? "a" : "p");
    row.className = "step";
    if (item.href) row.href = item.href;
    const mark = document.createElement("span");
    mark.textContent = item.n;
    row.append(mark, document.createTextNode(item.text));
    if (item.copy) {
      row.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          await navigator.clipboard.writeText(PAGE_URL);
          setStatus("網址已複製，請貼到 Safari 打開。", "ok");
        } catch (err) {
          setStatus(PAGE_URL, "warn");
        }
      });
    }
    box.append(row);
  }
}

function refreshHelper() {
  const on = document.documentElement.dataset.nthuHelper === "1";
  setup.hidden = on;
  helperState.hidden = !on;
}

fillSetup();
document.querySelector("#portal-note").textContent = (isIOS || isAndroid)
  ? "點了之後會打開學校的登入頁，帳號會先填好，驗證碼請自己輸入。"
  : "點了之後會打開學校的登入頁，由這台電腦辨識驗證碼並登入。";

document.addEventListener("nthu-helper", refreshHelper);
setTimeout(refreshHelper, 700);
