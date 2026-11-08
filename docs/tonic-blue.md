# Tonic Blue

雲端帳本的程式在 `cloud/`。**這次沒有部署、沒有建立 D1、沒有寫入真實帳、也沒有取代現在的手機帳本。**

現在還在用的是倉庫根目錄的 `index.html`（瀏覽器 localStorage，選用 Notion 同步）。Google Sheet / Drive 備份繼續當退路。Notion 資料庫存在，但筆數查詢沒有定論，不能說它已經同步或是空的。手機上可能還有沒進任何一份匯出的帳；切換前必須再比對一次。

## 這版做什麼

- 正式資料放在 Cloudflare D1。金額用整數「分」：1 單位 = 0.01 元。`22.5` 元是 `2250`，加減只用整數。超過兩位小數會拒絕，不四捨五入。
- 手機頁面是繁體中文、預設唯讀。不會把帳寫進 localStorage、IndexedDB，Service Worker 只快取靜態外殼，不快取 `/api/`。帳目仍會短暫出現在那一次畫面的記憶體裡，這是瀏覽器畫出來所必需的，關掉或讀取失敗會清掉，不會留一份帳本。
- 登入用至少 12 字的通行語，核對後發 HttpOnly cookie，角色是 `reader`。四到八位純數字不算設定完成。
- 助理用另一組至少 32 字的 `ASSISTANT_TOKEN`，放在 `Authorization: Bearer`。可以讀、可以新增與更新單筆、可以看遷移預覽。不能匯出整份備份、不能看稽核、不能執行遷移寫入或還原提交。
- 同一編號、內容相同：略過。同一編號、內容不同：雲端原筆不動，進來的內容放進 `review_items`。檔案裡沒有的雲端筆不刪除。
- 固定支出沿用欄位：業務體、項目、週期、本次帳單、本次實付、到期日、未來月額、備註、啟用。空白是未知，不是 0。這些欄位不會自動變成交易。

業務體鍵與顯示名：

| 鍵 | 顯示 | 歸類 |
| --- | --- | --- |
| `yapi` | 雅啤精釀 | 事業 |
| `taros` | 塔羅斯Talos | 事業 |
| `beerwang` | 啤酒王 | 事業 |
| `superhour` | 超時餐飲 | 事業 |
| `kaipi` | 開啤 | 事業 |
| `personal` | 日常生活支出 | 個人，不進事業合計 |

舊檔裡的 `Tonic Brewery`、`塔羅斯`、`超時`、`日常生活` 會對到上面的鍵。交易類別沿用舊帳本清單；遷移時不在清單裡的舊字串會保留並警告，新的寫入則必須用清單裡的字（含 `耗材-CO₂` 的下標 ₂）。

淨額＝收入−支出。它不是銀行餘額，也不是完整損益。

## 部署前提（還沒有）

這次查到 Cloudflare 帳號可連線，但 Workers 讀取是 403、D1/KV 是 401。因此**不能確認** `tonic-sync-api` 是否存在、綁了什麼、或驗證是否有效。不要用別的帳號、不要繞過權限、不要在這個 PR 合併時自動部署。

要部署的人需要在**現有 Cloudflare 帳號**上至少有：

- Workers Scripts：讀取與部署 `tonic-blue` 的權限
- D1：建立資料庫 `tonic-blue`、套用 migration、綁定到 Worker
- 設定 Worker secret 的權限

`cloud/wrangler.jsonc` 的 `database_id` 是佔位符 `00000000-0000-0000-0000-000000000001`，用來避免 Wrangler 自動建立資料庫。在換成真實 id 之前，部署不該成功。

沒有付費服務、沒有新帳號、沒有新倉庫。D1 與 Workers 用現有帳號的免費額度即可；這份程式沒有 Cron、沒有會自動記帳的排程。

### 之後由人在自己的機器執行

在 `cloud/`：

```bash
npm install
npx wrangler login
npx wrangler whoami
npx wrangler d1 create tonic-blue
```

把印出的 `database_id` 寫進 `cloud/wrangler.jsonc` 的 `database_id`。不要把 token 或帳本貼進 git。

```bash
npx wrangler d1 migrations apply tonic-blue --remote
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put ASSISTANT_TOKEN
npx wrangler deploy
```

`wrangler secret put` 會另外提示貼上值，值不要出現在指令參數、聊天或 PR。

Secret 名稱只有這兩個：

| 名稱 | 用途 | 最低要求 |
| --- | --- | --- |
| `OWNER_PASSWORD` | 手機登入。伺服器只發 `reader` cookie。要做遷移寫入時，另外送 `role: "owner"` 與標頭 `X-Tonic-Owner-Intent: 1` | 至少 12 字，不能是 1–8 位純數字 |
| `ASSISTANT_TOKEN` | 助理的 Bearer | 至少 32 字，不能全是數字 |

非機密變數：

| 名稱 | 預設 | 意義 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | 空 | 額外的瀏覽器來源，逗號分隔。空的時候只接受同一個網址。不要為了方便把 GitHub Pages 加進來。 |
| `APP_MODE` | `unverified` | `unverified`、`local-test`、`production`。在你親自看過一筆助理寫入、手機讀得到之前，保持 `unverified`。 |

本機試跑可以用 `.dev.vars`（已 gitignore），從 `.dev.vars.example` 複製。那組文字是佔位，不能拿去上線。

```bash
npx wrangler d1 migrations apply tonic-blue --local
npx wrangler dev
```

`wrangler dev` 會碰到本機 D1。確認沒有加 `--remote`，避免打到真的資料庫。

部署後先看：

```bash
curl -sS https://<worker>/api/v1/health
```

應為 JSON，`service` 是 `tonic-blue`，`canonicalClaim` 與 `notionSyncClaim` 都是 `none`，`phoneCompleteness` 是 `unknown`。`ready: true` 只表示綁定與通行語看起來齊了，**不表示帳已經搬完或對齊**。

## 助理怎麼寫

把 Worker 網址與 `ASSISTANT_TOKEN` 放在助理自己的秘密儲存，不要寫進這個公開倉庫、不要寫進聊天紀錄。權杖不要放在網址列。

OpenAPI：`cloud/openapi.yaml`。

新增一筆（金額用整數分，或用字串元，兩邊都給時必須相同）：

```http
POST /api/v1/transactions
Authorization: Bearer <ASSISTANT_TOKEN>
Idempotency-Key: example-key-0001
Content-Type: application/json

{
  "id": "tx_example_1",
  "date": "2026-11-03",
  "type": "expense",
  "entity": "yapi",
  "category": "原料-麥芽",
  "amountCents": 2250,
  "amount": "22.50",
  "hasInvoice": true,
  "note": "EXAMPLE"
}
```

然後：

```http
GET /api/v1/transactions/tx_example_1
Authorization: Bearer <ASSISTANT_TOKEN>
```

更新必須帶上次讀到的 `expectedVersion`，沒送到的欄位保留。版本不對會 409，原筆不變，兩邊內容進審閱。重試要重用同一個 `Idempotency-Key`；同一個 key 配不同內容會 409。

沒有刪除交易的 API。誤記用 `voided: true` 更新，統計會排除，資料還在。

固定支出：

```json
{
  "entity": "yapi",
  "item": "房租",
  "cycle": null,
  "billed": "1000.50",
  "paidCents": null,
  "dueDate": null,
  "futureMonthly": "1000.50",
  "enabled": true,
  "note": "EXAMPLE 到期未知"
}
```

`null` 就是未知。不要為了填滿而發明到期日。

## 遷移（稍後、在倉庫外面）

不要把真實匯出檔提交進 git。在自己的機器上對已部署的 API 做。

1. 從舊帳本匯出 JSON：`{ "version": "0.1", "exportedAt", "txs" }`。也接受 `{ "count", "transactions" }`。固定支出可放 `固定支出` 或 `obligations`，欄位用上面的中文名。
2. 用擁有者登入（見下方）呼叫 `POST /api/v1/migration/compare`。這一步不寫入。
3. 看報告：`onlyInCandidate`、`onlyInCanonical`、`conflicts`、`invalid`、`warnings`。`onlyInCanonical` 可能是別台裝置已經進來的帳，不能因為這份檔沒有就刪掉。`phoneCompleteness` 永遠是 `unknown`。
4. 同一編號內容不同：不要覆蓋。兩邊都留著。若要改雲端那筆，用助理的 PUT 帶正確版本，那是一筆新的明確修改，會進稽核。
5. 檔案裡有壞列、超過兩位小數、或同一編號兩種內容，`POST /api/v1/migration/apply` 會 400，什麼都不寫。
6. 通過之後才 `apply`。相同內容略過，新編號插入，衝突只進審閱。再跑一次應該還是相同結果。
7. 還原可以先 `POST /api/v1/restore/stage`（只暫存，不動正式表），看完再 `POST /api/v1/restore/<id>/commit`。捨棄暫存不會刪帳。

擁有者登入（不要從手機頁面做；手機頁面只送一般登入）：

```http
POST /api/v1/session
Content-Type: application/json
X-Tonic-Owner-Intent: 1

{ "password": "<OWNER_PASSWORD>", "role": "owner" }
```

回應的 Set-Cookie 是 HttpOnly。瀏覽器同源請求會自己帶上。curl 請自己保存 cookie，不要把通行語寫進 repo。

舊匯出的 `amount` 是「元」，不是「分」。`22.5` 會變成 `2250`。`tonic-blue-1` 備份同時有 `amountCents` 與 `amount`，以分為準，兩者不一致就拒絕。

## 上線後怎麼確認

1. `GET /api/v1/health`：`ready` 為 true，宣稱欄位仍是 none / unknown。
2. 助理用測試編號寫一筆 EXAMPLE（或你自己的一筆），`GET` 同一編號，金額的分與元一致。
3. 手機打開 Worker 網址（不是 GitHub Pages），登入，總覽看得到該筆。事業合計不含「日常生活支出」。淨額標的是收入減支出。
4. 固定支出的空白到期日顯示「未知」。
5. 關掉頁面再打開，會重新向雲端讀。讀取失敗時畫面是失敗說明，不是示範帳。
6. 確認舊網址 `https://tonicwang.github.io/tonic-brewery-ledger/` 仍是原來的帳本。
7. 看過真實讀寫之後，才把 `APP_MODE` 改成 `production`。在那之前畫面會說環境尚未標記為正式帳本。

GitHub Pages 上的 `/cloud/public/` 沒有 API。那裡應該顯示連不上，而不是一組假帳。`?preview=test` 會明白標成測試資料。

## 退回

- 不要刪舊的 `index.html`、`sync.js`、`sync-worker/`，也不要清手機 localStorage 或 Notion。
- 不把流量切到新 Worker，舊站就還是現況。
- 新 Worker 可以停用或用 Wrangler 回到上一版程式。回到上一版**不會**把 D1 的資料一起倒回去。資料還在 D1 時，用匯出的 `tonic-blue-1` JSON 留底。
- 遷移沒有刪除或覆蓋既有列。若要放棄尚未 commit 的還原暫存，呼叫 discard。

## 本機測試

```bash
cd cloud
npm test
npm run typecheck
```

`npm test` 用合成的 EXAMPLE 資料。`npm run typecheck` 會先跑 `wrangler types`（產生的 `worker-configuration.d.ts` 不進 git）。

## Parent checklist

Do these on a machine that already has the Cloudflare account. Do not paste passwords, the assistant token, or a real export into the repo or chat.

1. Permission gate: Workers script read/write for `tonic-blue`, D1 create + migrations, secret write. The audited token was Workers read 403 and D1/KV 401, so deployment is blocked until that changes. Do not switch accounts to get around it.
2. `npx wrangler d1 create tonic-blue` and replace the placeholder `database_id` in `cloud/wrangler.jsonc`.
3. `npx wrangler d1 migrations apply tonic-blue --remote` (the SQL is `cloud/migrations/0001_init.sql`).
4. `npx wrangler secret put OWNER_PASSWORD` and `npx wrangler secret put ASSISTANT_TOKEN` using the rules above.
5. `npx wrangler deploy` from `cloud/`. This does not replace the GitHub Pages app or `sync-worker`.
6. Store the assistant token only in the assistant's secret store. Calls are Bearer auth to `/api/v1/*` as in `cloud/openapi.yaml`. No token in the query string.
7. Before any cutover: export from the phone locally, `POST /api/v1/migration/compare`, and review `onlyInCanonical`, `onlyInCandidate`, and `conflicts`. A phone export is not proof it is the full set. Notion was not shown to be empty or caught up. Sheet/Drive stay as the fallback.
8. `apply` is idempotent for the same id and payload, and it parks divergent payloads. It does not delete rows that are only in D1.
9. Prove a phone read of an assistant write on the Worker origin. Only then set `APP_MODE` to `production`.
10. Rollback is "keep serving the old site". Do not delete the old app, local browser data, Notion, or the sheet.
