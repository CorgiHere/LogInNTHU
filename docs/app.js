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
      setStatus(library ? "請先填寫圖書館帳號和密碼。" : "請先填寫校務帳號和密碼。", "warn");
      (library ? libraryAccount : account).focus();
    }
  });
}

function refreshHelper() {
  const on = document.documentElement.dataset.nthuHelper === "1";
  setup.hidden = on;
  helperState.hidden = !on;
}

document.addEventListener("nthu-helper", refreshHelper);
setTimeout(refreshHelper, 700);
