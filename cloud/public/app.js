import { ENTITIES, formatTwd, summarize } from "./format.js";

const app = document.querySelector("#app");
const views = ["dashboard", "ledger", "obligations", "status"];
const state = {
  view: views.includes(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard",
  mode: "loading",
  health: null,
  role: null,
  range: monthRange(taipeiToday()),
  query: "",
  txs: [],
  obligations: [],
  stats: null,
  message: "",
};

boot();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(() => undefined);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("preview") === "test") {
    state.range = { from: "2026-11-01", to: "2026-11-30" };
    await loadPreview();
    return;
  }
  const health = await getJson("api/v1/health");
  if (health.status === 0 || !health.body || health.body.service !== "tonic-blue") {
    state.mode = "offline";
    state.message = location.hostname.endsWith("github.io")
      ? "這是公開的靜態網頁，沒有雲端 API。不會改顯示測試帳。"
      : "連不上 Tonic Blue API。沒有改用手機裡的舊帳，也沒有改顯示測試帳。";
    render();
    return;
  }
  state.health = health.body;
  if (!health.body.ready) {
    state.mode = "unconfigured";
    render();
    return;
  }
  const session = await getJson("api/v1/session");
  if (session.status === 401) {
    state.mode = "auth";
    render();
    return;
  }
  if (!session.ok) {
    state.mode = "offline";
    state.message = "雲端有回應，但沒有讀到登入狀態。沒有改顯示測試帳。";
    render();
    return;
  }
  state.role = session.body.role;
  await loadLive();
}

async function loadPreview() {
  const response = await getJson("fixture.example.json");
  if (!response.ok || !String(response.body?.label || "").includes("TEST")) {
    state.mode = "offline";
    state.message = "測試資料檔沒有讀到。不會把它當成正式帳。";
    render();
    return;
  }
  state.mode = "preview";
  state.catalogTxs = response.body.transactions;
  state.obligations = response.body.obligations;
  applyPreviewFilter();
  render();
}

async function loadLive() {
  const params = new URLSearchParams({ from: state.range.from, to: state.range.to });
  if (state.query) params.set("q", state.query);
  const [txs, stats, obligations] = await Promise.all([
    getJson(`api/v1/transactions?${params}`),
    getJson(`api/v1/stats?${params}`),
    getJson("api/v1/obligations"),
  ]);
  if ([txs, stats, obligations].some((item) => item.status === 401)) {
    clearLedger();
    state.mode = "auth";
    render();
    return;
  }
  if (![txs, stats, obligations].every((item) => item.ok && item.body?.ok)) {
    clearLedger();
    state.mode = "offline";
    state.message = "讀取雲端帳目失敗。這頁不會留下上一次的數字，也不會改顯示測試帳。";
    render();
    return;
  }
  state.mode = "ready";
  state.txs = txs.body.transactions;
  state.stats = stats.body.stats;
  state.obligations = obligations.body.obligations;
  render();
}

function clearLedger() {
  state.txs = [];
  state.stats = null;
  state.obligations = [];
}

async function getJson(path) {
  try {
    const response = await fetch(new URL(path, document.baseURI), { credentials: "same-origin", cache: "no-store" });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function render() {
  app.replaceChildren();
  const wrap = el("main", "wrap");
  wrap.append(header(), banner());
  if (state.mode === "loading") wrap.append(panel("正在詢問雲端…"));
  else if (state.mode === "auth") wrap.append(loginCard());
  else if (state.mode === "offline" || state.mode === "unconfigured") wrap.append(blockedCard());
  else {
    wrap.append(filters());
    if (state.view === "dashboard") wrap.append(dashboard());
    if (state.view === "ledger") wrap.append(ledger());
    if (state.view === "obligations") wrap.append(obligations());
    if (state.view === "status") wrap.append(statusView());
    document.body.append(nav());
  }
  app.append(wrap);
}

function header() {
  const top = el("header", "top");
  const text = el("div");
  text.append(el("p", "mark", "Tonic Blue"), el("h1", null, "雲端帳本"), el("p", "sub", "手機只看。記帳由已驗證的助理寫入雲端。"));
  top.append(text, el("div", "pill", "唯讀"));
  return top;
}

function banner() {
  if (state.mode === "preview") return noteBanner("test", "測試資料 EXAMPLE", "合成數字，用來看版面。不是雲端帳，也不是你的帳，重新整理這頁也不會把它存進手機。");
  if (state.mode === "ready" && state.health?.appMode === "local-test") return noteBanner("test", "本地測試", "這台伺服器是測試用的。數字若是 EXAMPLE，就不是已上線的正式帳本。");
  if (state.mode === "ready" && state.health?.appMode !== "production") return noteBanner("warn", "環境尚未標記為正式帳本", "可以讀到目前這個 API 的資料，但這不代表手機、Notion 或試算表已經對齊，也不能當成已完成切換。");
  return el("div");
}

function noteBanner(kind, title, text) {
  const box = el("div", `banner ${kind}`);
  box.append(el("strong", null, title), document.createTextNode(text));
  return box;
}

function filters() {
  const box = el("div", "controls");
  const from = dateInput("起", state.range.from, (value) => { state.range.from = value; refresh(); });
  const to = dateInput("迄", state.range.to, (value) => { state.range.to = value; refresh(); });
  const search = el("label");
  search.append(document.createTextNode("搜尋備註、類別、編號"));
  const input = document.createElement("input");
  input.value = state.query;
  input.placeholder = "EXAMPLE 或類別";
  input.addEventListener("change", () => { state.query = input.value; refresh(); });
  search.append(input);
  const month = el("button", "quiet", "這個月");
  month.type = "button";
  month.addEventListener("click", () => { state.range = monthRange(taipeiToday()); refresh(); });
  box.append(from, to, search, month);
  return box;
}

function dashboard() {
  const stats = state.stats;
  const section = el("section", "stack");
  if (!stats) {
    section.append(panel("沒有統計。"));
    return section;
  }
  const cards = el("div", "grid cards");
  cards.append(moneyCard("business", "事業合計", "不含日常生活", stats.business));
  cards.append(moneyCard("personal", "日常生活", ENTITIES.personal.label, stats.personal));
  section.append(cards);
  section.append(compareCard(stats));
  section.append(bars("支出去向（類別）", stats.expenseByCategory, "category"));
  section.append(bars("支出明細（備註）", (stats.expenseByNote || []).map((row) => ({ key: row.note, cents: row.cents })), "note"));
  section.append(trendCard(stats.trend || []));
  section.append(el("p", "meta", stats.disclaimer || "淨額＝收入−支出，不是銀行餘額。"));
  return section;
}

function moneyCard(kind, title, caption, bucket) {
  const card = el("article", `panel ${kind}`);
  card.append(el("p", "kicker", title), el("p", "meta", caption));
  const net = el("p", `money ${bucket.netCents < 0 ? "bad" : "good"}`);
  net.append(el("small", null, "NT$"), document.createTextNode(formatTwd(bucket.netCents)));
  card.append(net, el("p", "meta", "淨額（收入−支出），不是銀行餘額"));
  const split = el("div", "split");
  split.append(el("div", "meta", `收入 ${formatTwd(bucket.incomeCents)}`), el("div", "meta", `支出 ${formatTwd(bucket.expenseCents)}`));
  card.append(split);
  return card;
}

function compareCard(stats) {
  const card = panel("");
  card.append(el("h2", null, "和前一段比"));
  const delta = stats.comparison?.delta;
  if (!delta) {
    card.append(el("p", "meta", "這段是測試版面，趨勢在下面。正式 API 會附上一段同等天數的比較。"));
    return card;
  }
  card.append(el("p", null, `事業淨額變化 ${signed(delta.businessNetCents)}`));
  card.append(el("p", null, `個人淨額變化 ${signed(delta.personalNetCents)}`));
  card.append(el("p", "meta", "變化也是收入減支出的差，不是帳戶餘額增減。"));
  return card;
}

function bars(title, rows, keyName) {
  const card = panel("");
  card.append(el("h2", null, title));
  if (!rows?.length) {
    card.append(el("p", "empty", "這段沒有支出。"));
    return card;
  }
  const max = Math.max(...rows.map((row) => row.cents), 1);
  for (const row of rows) {
    const line = el("div", "bar-row");
    const track = el("div", "track");
    const fill = document.createElement("span");
    fill.style.width = `${Math.round((row.cents / max) * 100)}%`;
    track.append(fill);
    line.append(el("span", null, row[keyName] || row.key), track, el("strong", null, formatTwd(row.cents)));
    card.append(line);
  }
  return card;
}

function trendCard(trend) {
  const card = panel("");
  card.append(el("h2", null, "近六個月事業淨額"));
  const max = Math.max(...trend.map((item) => Math.abs(item.business.netCents)), 1);
  for (const item of trend) {
    const line = el("div", "bar-row");
    const track = el("div", "track");
    const fill = document.createElement("span");
    fill.style.width = `${Math.round((Math.abs(item.business.netCents) / max) * 100)}%`;
    track.append(fill);
    line.append(el("span", null, item.month), track, el("strong", null, formatTwd(item.business.netCents)));
    card.append(line);
  }
  card.append(el("p", "meta", "個人支出不在這組長條裡。"));
  return card;
}

function ledger() {
  const card = panel("");
  card.append(el("h2", null, "明細"));
  if (!state.txs.length) {
    card.append(el("p", "empty", "這段期間沒有交易。這是空的結果，不是測試帳。"));
    return card;
  }
  for (const tx of state.txs) {
    const row = el("div", "row");
    row.append(el("div", null, tx.date), textBlock(`${tx.entityLabel || ENTITIES[tx.entity]?.label || tx.entity} · ${tx.category}`, tx.note || ""), el("strong", null, `${tx.type === "income" ? "+" : "−"}${formatTwd(tx.amountCents)}`));
    card.append(row);
  }
  return card;
}

function obligations() {
  const card = panel("");
  card.append(el("h2", null, "固定支出登記"));
  card.append(el("p", "meta", "這些是計畫與登記欄位，不是已入帳的交易。空白表示未知，不會被補成 0，也不會自動產生未來付款。"));
  if (!state.obligations.length) {
    card.append(el("p", "empty", "雲端還沒有固定支出登記。"));
    return card;
  }
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["業務體", "項目", "週期", "本次帳單", "本次實付", "到期日", "未來月額", "啟用"]) {
    head.append(el("th", null, label));
  }
  table.append(head);
  for (const row of state.obligations) {
    const tr = document.createElement("tr");
    tr.append(
      cell(row.entityLabel || ENTITIES[row.entity]?.label || row.entity),
      cell(row.item),
      cell(row.cycle, true),
      moneyCell(row.billedCents),
      moneyCell(row.paidCents),
      cell(row.dueDate, true),
      moneyCell(row.futureMonthlyCents),
      cell(row.enabled == null ? null : row.enabled ? "啟用" : "停用", row.enabled == null),
    );
    table.append(tr);
  }
  card.append(table);
  const summary = state.stats?.obligations;
  if (summary) {
    const known = summary.unknownFutureCount ? `已知未來月額 ${formatTwd(summary.knownFutureMonthlyCents)}，另有 ${summary.unknownFutureCount} 筆月額未知，所以沒有完整合計。` : `啟用中的未來月額 ${formatTwd(summary.knownFutureMonthlyCents)}。`;
    card.append(el("p", "meta", `${known} 到期未知 ${summary.unknownDue} 筆，實付未知 ${summary.unknownPaid} 筆。這些數字沒有算進淨額。`));
  }
  return card;
}

function statusView() {
  const card = panel("");
  card.append(el("h2", null, "狀態"));
  const health = state.health;
  card.append(el("p", null, state.mode === "preview" ? "現在是測試版面。" : `登入身分：${state.role || "未知"}`));
  if (health) {
    card.append(el("p", "meta", `儲存：${health.storage || "未知"}。正式宣稱：${health.canonicalClaim}。Notion 對齊宣稱：${health.notionSyncClaim}。手機是否還有未上傳的帳：${health.phoneCompleteness}。`));
  }
  card.append(el("p", "meta", "帳目不會留在這支手機裡。重新整理會再向雲端要一次。畫面上的數字只活在這次開啟的記憶體，關掉就沒有。登入 cookie 由伺服器寫入，裡面沒有任何一筆交易。靜態畫面可以被瀏覽器留作外殼，帳目回應不會。"));
  card.append(el("p", "meta", "舊的手機帳本、試算表和雲端硬碟備份都還在。這個畫面不是切換完成的證明。"));
  if (state.mode === "ready") {
    const button = el("button", "primary", "下載雲端備份");
    button.type = "button";
    button.addEventListener("click", downloadBackup);
    card.append(button);
  }
  return card;
}

function loginCard() {
  const card = panel("");
  card.append(el("h2", null, "登入後才看得到帳"));
  card.append(el("p", "meta", "密碼只送去伺服器核對。送出後欄位會清掉。這個畫面不能新增交易。"));
  const form = el("form", "login");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "current-password";
  input.required = true;
  input.placeholder = "通行語，不是四位數 PIN";
  const button = el("button", "primary", "登入");
  button.type = "submit";
  const error = el("p", "meta", state.message);
  form.append(input, button, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = input.value;
    input.value = "";
    const response = await fetch(new URL("api/v1/session", document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      state.message = "登入失敗。沒有顯示任何帳目。";
      render();
      return;
    }
    state.role = "reader";
    await loadLive();
  });
  card.append(form);
  return card;
}

function blockedCard() {
  const card = panel("");
  const title = state.mode === "unconfigured" ? "雲端還沒設定完成" : "現在沒有帳可看";
  card.append(el("h2", null, title), el("p", null, state.message || "資料庫或登入通行語還沒準備好。這不是一組示範帳。"));
  const preview = el("a", "quiet", "只看版面測試資料");
  preview.href = "?preview=test";
  card.append(preview);
  return card;
}

function nav() {
  const existing = document.querySelector(".nav");
  if (existing) existing.remove();
  const bar = el("nav", "nav");
  for (const item of [["dashboard", "總覽"], ["ledger", "明細"], ["obligations", "固定支出"], ["status", "狀態"]]) {
    const button = el("button", `nav-btn${state.view === item[0] ? " active" : ""}`, item[1]);
    button.type = "button";
    button.addEventListener("click", () => {
      state.view = item[0];
      history.replaceState(null, "", `#${item[0]}`);
      render();
    });
    bar.append(button);
  }
  return bar;
}

async function downloadBackup() {
  const response = await fetch(new URL("api/v1/export", document.baseURI), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    state.message = "備份沒有下載成功。";
    render();
    return;
  }
  const blob = new Blob([await response.text()], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "tonic-blue-backup.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refresh() {
  if (state.mode === "preview") {
    if (!state.catalogTxs) state.catalogTxs = await previewRows();
    applyPreviewFilter();
    render();
    return;
  }
  await loadLive();
}

function applyPreviewFilter() {
  const all = state.catalogTxs || [];
  const matched = (tx) => !state.query || `${tx.note} ${tx.category} ${tx.id}`.includes(state.query);
  state.txs = all.filter((tx) => tx.date >= state.range.from && tx.date <= state.range.to && matched(tx));
  state.stats = summarize(all.filter(matched), state.obligations, state.range);
}

async function previewRows() {
  const response = await getJson("fixture.example.json");
  return response.body?.transactions || [];
}

function dateInput(label, value, onChange) {
  const wrap = el("label");
  wrap.append(document.createTextNode(label));
  const input = document.createElement("input");
  input.type = "date";
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  wrap.append(input);
  return wrap;
}

function panel(text) {
  const card = el("section", "panel");
  if (text) card.append(el("p", null, text));
  return card;
}

function textBlock(title, note) {
  const box = el("div");
  box.append(el("div", null, title));
  if (note) box.append(el("div", "note", note));
  return box;
}

function cell(value, unknown) {
  const item = el("td", unknown || value == null || value === "" ? "unknown" : null, value == null || value === "" ? "未知" : String(value));
  return item;
}

function moneyCell(cents) {
  if (cents == null) return cell(null, true);
  return cell(formatTwd(cents), false);
}

function signed(cents) {
  const text = formatTwd(cents);
  return cents > 0 ? `+${text}` : text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function monthRange(day) {
  const month = day.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
