# tonic-brewery-ledger

收入支出系統。帳本預設只把資料放在這台裝置的瀏覽器。設定雲端同步之後，會透過 Cloudflare Worker 寫進 Notion：手機上改一筆，或直接在 Notion 改一列，下次讀取都會拿到較新的那筆。

這個倉庫是公開的。`NOTION_TOKEN` 與 `APP_PIN` 只能放在 Cloudflare 的 secret，或你自己手機的瀏覽器裡。不要寫進檔案、不要貼到 commit、issue 或 pull request。

## 雲端同步

### 1. 建立 Notion 整合並分享兩個資料庫

1. 打開 [Notion integrations](https://www.notion.so/my-integrations)，新增一個 Internal Integration。
2. 複製 integration token。這個值只貼給下面的 `wrangler secret put`，不要存進 git。
3. 在 Notion 打開「三品牌收支帳」與「客戶承諾追蹤」。各自用右上角「…」→ Connections，把這個 integration 加進去。沒分享的資料庫，Worker 會讀寫失敗。

帳本資料庫 id 已寫在 `sync-worker/wrangler.toml` 的 `NOTION_LEDGER_DB`。客戶承諾追蹤的 id 是 `NOTION_CRM_DB`。

### 2. 設定 secret 並部署 Worker

在 `sync-worker/`：

```bash
npm install
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put APP_PIN
npx wrangler deploy
```

`wrangler secret put` 會另開提示請你貼上值，值不會出現在指令參數或這個倉庫裡。本地試跑用的 `.dev.vars` 已在 `.gitignore`，請從 `.dev.vars.example` 複製，不要提交。

`APP_PIN` 自己設一組夠長的數字或文字。手機帳本要填同一組。`NOTION_LEDGER_DB` 若要改，只改 `wrangler.toml` 的變數，不要把 token 寫進去。

部署要用你自己的 Cloudflare 帳號。這個倉庫沒有 Cloudflare token，也不會自動部署。

### 3. 在手機帳本啟用

1. 打開 [tonicwang.github.io/tonic-brewery-ledger](https://tonicwang.github.io/tonic-brewery-ledger/)。
2. 到「設定」→「雲端同步」。
3. Worker URL 填部署完成後的網址，形如 `https://tonic-sync-api.<帳號>.workers.dev`。
4. PIN 填上一步的 `APP_PIN`。它只存在這台裝置的 localStorage。
5. 按「儲存同步設定」，再按「一次上傳全部本機資料」。

之後每次記帳會先寫進手機，再推到 Notion。推送失敗會留在 `sync:outbox`，下次打開帳本再送。網路不通或還沒填 URL / PIN 時，帳本跟以前一樣只使用本機資料，不會擋住記帳。

## API 契約

給另一個塔羅斯 CRM app 直接呼叫。除了 `GET /health`，每個請求都要帶 header `X-App-Pin: <APP_PIN>`。瀏覽器還會帶 `Origin`，Worker 只接受 `ALLOWED_ORIGINS`（預設 `https://tonicwang.github.io`，多個來源用逗號分隔）。沒有 `Origin` 的伺服器呼叫只檢查 PIN。

成功與失敗都是 JSON。回應不會帶回 token 或 PIN。`Cache-Control: no-store`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/health` | 不需 PIN。`{"ok":true,"service":"tonic-sync-api"}` |
| GET | `/ledger/txs` | 全部帳。可加 `?month=YYYY-MM` |
| PUT | `/ledger/txs/:id` | 依 `外部ID` 新增或更新 |
| DELETE | `/ledger/txs/:id` | 軟刪除，Notion `已刪除` 設為 true |
| POST | `/ledger/bulk` | 陣列上傳，給第一次整批 |
| GET | `/crm/records` | 讀回 CRM app 自己的形狀 |
| PUT | `/crm/records/:inquiryId` | 依 `外部ID` 新增或更新 |
| POST | `/crm/bulk` | CRM 陣列上傳 |

路徑上的 id 為準。找不到的 DELETE 回 `404` `{"ok":false,"error":"not found"}`。PIN 錯誤是 `401` `{"ok":false,"error":"unauthorized"}`。不允許的 Origin 是 `403` `{"ok":false,"error":"origin not allowed"}`。Notion 失敗是 `502` `{"ok":false,"error":"notion request failed"}`，內容不含上游回應。

預檢 `OPTIONS` 成功時回 `204`，並允許 header `Content-Type` 與 `X-App-Pin`。

### 帳本

PUT 與 bulk 的每一筆：

```json
{
  "id": "tx_1",
  "date": "2026-10-03",
  "type": "expense",
  "entity": "beerwang",
  "category": "耗材-CO₂",
  "amount": 1200,
  "hasInvoice": true,
  "note": "鋼瓶",
  "deleted": false,
  "updatedAt": "2026-10-26T00:00:00.000Z"
}
```

`entity` 用帳本的 key：`yapi`、`taros`、`beerwang`、`superhour`、`kaipi`、`personal`。`category` 必須與帳本選項完全一致，包含 `耗材-CO₂` 的下標 ₂。`type` 只接受 `income` 或 `expense`。

GET 回 `{"ok":true,"txs":[...]}`。`updatedAt` 是 Notion 的「最後更新」。`deleted: true` 的列也會回來，讓客戶端把本機那筆清掉。

Bulk 接受 `{"txs":[...]}` 或最外層陣列，回 `{"ok":true,"upserted":1,"txs":[...]}`。一次最多 2000 筆。

### CRM

PUT 與 bulk 的每一筆用 CRM app 的欄位。路徑上的 `inquiryId` 會覆蓋 body。`history` 與其他沒對到欄位的內容會原樣放進頁面的 JSON code block，讀回來不會少。

```json
{
  "inquiryId": "inq-1",
  "customerName": "王先生",
  "phone": "0912000111",
  "lineId": "wang-line",
  "productType": "設備",
  "quantity": 2,
  "quotePrice": 504000,
  "followUpDate": "2026-11-02",
  "lastContactDate": "2026-10-20",
  "owner": "啤酒王",
  "notes": "急件",
  "status": "quoted",
  "history": [{ "at": "2026-10-20", "action": "建立" }]
}
```

`status`：`pending_quote` → 階段「詢價」／狀態「待處理」；`quoted` →「報價」／「等客戶」；`negotiating` →「報價」／「待確認」；`signed` →「成交」／「已關閉」；`dead` → 狀態「已關閉」，階段維持原值。若要在新建時寫階段，可額外帶 `stage`（詢價、報價、成交、回購）。

GET 回 `{"ok":true,"records":[...]}`。PUT 回 `{"ok":true,"record":{...}}`。Bulk 接受 `{"records":[...]}` 或最外層陣列，回 `{"ok":true,"upserted":1,"records":[...]}`。讀取時 `updatedAt` 一樣是 Notion 的最後更新時間。直接在 Notion 改客戶、金額、日期、階段或狀態，下一次 GET 會蓋過 code block 裡的舊欄位；`history` 仍以 code block 為準。

Notion 欄位對應：項目為標題（客戶加產品）、客戶、聯絡方式（`phone / lineId`）、承諾內容／下一步（`productType × quantity`）、金額、下次追蹤、最後聯絡、負責人、備註、品牌固定「塔羅斯」、來源為多選 `["塔羅斯CRM"]`、外部ID 為 `inquiryId`。帳本的來源則是單選「帳本App」。
