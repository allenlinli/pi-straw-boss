# 設定無人值守裝置

[English](unattended-device.md) | 繁體中文

無人值守裝置（unattended device）是沒有人坐在前面的電腦（建置機、伺服器），其他人的電腦透過 Straw Link 把工作送來給它。它由自己的 infra 負責設定：這一頁寫的是 infra 要把什麼放在哪裡。
設計見 [Straw Link 規格](specs/2026-10-25-straw-link.md)（Storage and policy、Unattended devices）和
[sb server 規格](specs/2026-10-26-sb-backend.md)（Unattended devices、rebased）；程式實際怎麼做，見 [運作方式](how-it-works.md)（Straw Link）。以上三份都是英文。

這件事牽涉兩台電腦。裝置由它的 infra 設定（第 1、2、4、5 節）。控制端（controller）是團隊管理員有人值守的電腦，由它建立團隊和邀請，並核准加入（第 3 節）。

**沒有開機時啟動的 pi session。** sb server（`cli.mjs serve`）就是連線持有者（link holder），所以同一個沒有特權的使用者底下會跑兩個長駐程序：Herdr server 和 sb server。

## 1. 兩個程序：systemd user unit

兩個都用 `env -i` 啟動，只帶 `HOME`、`PATH`、`TERM` 和 `LANG`，Herdr 用它的**預設** socket，這樣 sb server 才是主要的那一個（具名的 `herdr --session` 在網裡看不到，而從 pi session 繼承來的環境變數，會讓每個 pane 裡的 pi 都以為自己是子智慧體）。要啟用 lingering，unit 才會在開機時、不用登入就啟動：
`loginctl enable-linger <user>`。

`~/.config/systemd/user/herdr.service`：

```ini
[Unit]
Description=Herdr server (default socket)

[Service]
ExecStart=/usr/bin/env -i HOME=%h PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 herdr server
Restart=always

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/straw-boss.service`：

```ini
[Unit]
Description=Straw Boss server (the Straw Link holder)
After=herdr.service
Requires=herdr.service

[Service]
ExecStart=/usr/bin/env -i HOME=%h PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 node <pi-straw-boss>/cli.mjs serve
Restart=always

[Install]
WantedBy=default.target
```

要用 `herdr server`，不是 `herdr`：後者需要終端機。另外要裝一次 Herdr 的 pi 整合（`herdr integration install pi`），Herdr 才能從 session 檔恢復 pi 的 pane。在 macOS 上，同樣的兩個指令改以 launchd daemon 執行，帶 `UserName`，環境變數相同。

## 2. 政策檔

`/etc/straw-link/policy.json`（路徑固定寫在 `src/link/policy.ts`）。它決定這台裝置是無人值守的，聽哪些控制端的、信任到哪一級，以及接受哪些團隊、團隊的工作在哪裡進行。**擁有者 `root:root`、權限 `0644`，所在目錄也要是 `root` 擁有、`0755`**：檢查會要求檔案和它的目錄都屬於 server 執行身分以外的使用者、都不是 symlink、也都不能被那個使用者寫入，不符合就拒絕無人值守模式。

```json
{
  "unattended": true,
  "trust": { "<controller device id>": "dispatch" },
  "teams": { "<team id>": { "project": "/srv/work/moldplan-center", "share": "status" } }
}
```

- 控制端的值寫 `true` 而不是等級，就是 `dispatch`。沒列出來的人預設是 `reply`。
- `project` 要是絕對路徑，並通過和 `link.teams` 同一套檢查（不能是家目錄，也不能是 pi 的資料夾）。`share` 預設 `status`。
- 無人值守裝置會**忽略** `config.json` 的 `link` 區段，連中繼站（relay）也是：中繼站來自邀請。
- 檔案寫了 `unattended: true` 卻沒通過檢查，或 `teams` 格式有誤，就會**拒絕**無人值守模式：不啟動持有者、每個寄件者都是 `reply`、團隊清單是空的。原因只會寫一次到 `link/link.log`（`policy-refused`），並以 server 的一行紀錄通知顯示。

## 3. 控制端這一邊：團隊、邀請、核准

這一節在有人值守的電腦的 GUI 裡做；核准也可以在 pi 裡做。這裡的任何一步都不會動到裝置。

1. **開啟 Straw Link。** 那台電腦的 Straw Link 還沒在跑時，設定 → 團隊會顯示「設定 Straw Link」。按下去，等幾秒；它也會寫下 `link/enabled`。
2. **建立團隊**（每個團隊做一次；團隊已經有了就跳過）。中繼站的管理者會給你一次性的團隊 token。打開「建立團隊」，填中繼站網址、團隊 token、「這台電腦的名稱」、「分享」（分享你的塔台與分頁狀態，或只分享你在線），以及專案資料夾，再按「建立團隊」。token 欄位是密碼欄位，所以點它的時候，密碼管理員的內嵌選單可能會搶走焦點：貼上之前先把選單關掉。token 用過之後，頁面會把它清掉。
3. **讀出裝置的政策檔需要的兩個 id**（第 2 節）。控制端的裝置 id 在團隊頁的標題列（「裝置 id …」），也在 `<pi agent dir>/straw-boss/link/device.id`。團隊 id 是 32 個十六進位字元：頁面只顯示前六個，完整的 id 是團隊檔 `<pi agent dir>/straw-boss/link/teams/<team id>.json` 的檔名。
4. **邀請裝置。** infra 從裝置上的 `link/device.id` 讀出裝置的 id（26 個字元）交給你。在團隊的卡片上按「邀請無人值守裝置」，把 id 輸入「26 個字元的裝置 id」欄位，再按「邀請」。頁面會把邀請顯示成 QR code 和文字，並寫出它還有多久失效；按「複製」。綁定裝置的邀請在將近 24 小時後失效（一般邀請是 10 分鐘），只能用一次。
5. **把文字交給 infra**，由他放進裝置上的 `join.txt`（第 4 節）。
6. **核准加入。** 裝置的持有者向中繼站提出要求後，團隊頁會出現一張「…（無人值守的裝置）要求加入團隊 …」的卡片，連結列也會跳出通知，附「查看」按鈕。這裡不用比對四個單字：你的邀請裡的裝置 id 取代了它。按「核准」（或「拒絕」）。在 pi 裡，`/boss link` 會列出等待中的要求和短 id，`/boss link decide <id> approve|refuse` 負責決定；核准無人值守的裝置之前，pi 會先請你確認，而已配對的手機可以看這些要求，不能決定。
7. **檢查。** 裝置出現在團隊的名冊裡，「類型」欄寫「無人值守」。它對你的訊息的信任等級是政策檔寫的，不是名冊寫的：你的控制端裝置 id 要在政策的 `trust` 裡，等級 `dispatch`（第 2 節）。

## 4. 加入：`join.txt`

無人值守裝置沒有螢幕可以貼邀請。有人值守的電腦上的管理員建立一張綁定這台裝置 id 的邀請，infra 把文字放進
`<pi agent dir>/straw-boss/link/join.txt`，這個檔要**屬於 server 自己的使用者、權限 `0600`、是一般檔案**（不能是 symlink）。裝置的 id 在 `link/device.id`（26 個字元，a 到 z 與 2 到 7）；server 第一次看（first look）時就會產生它，早於任何團隊，所以管理員可以先把邀請綁在這個 id 上。

持有者啟動時會讀這個檔，之後只要沒有正在進行的加入，每個 tick 都讀一次；它向中繼站提出要求，等管理員核准，然後寫入團隊檔（絕不寫 `config.json`），project 和 share 取自政策檔，最後記錄一個結果（`joined`、`refused`、`lapsed`、`failed`、`already-member`），之後檔案就刪除。政策檔沒有列出的團隊的邀請，或沒有綁定這台裝置 id 的邀請，在中繼站聽到之前就會被拒絕。如果連不上中繼站，或中繼站回的是暫時性的失敗，檔案會留著，隔一段時間再試（`join-file-retry`，30 秒起、最長 5 分鐘）。檔案刪不掉（資料夾不可寫）時，只報告一次，然後不再理它，直到檔案改變。檔案檢查只要有一項失敗，就會把檔案刪掉，所以外洩的秘密不會留在磁碟上。server 在加入進行到一半時重啟，邀請就丟了：再放一張新的。邀請的文字不會被記錄。

## 5. 預先信任專案：`trust.json`

專案資料夾的 `.pi/settings.json` 和 extension，在 pi 第一次在其中啟動時會詢問是否信任，工作目錄或它上面任何一層資料夾裡的 `.agents/skills` 也一樣。這裡沒有人可以回答。裝置設定時，把綁定的專案寫進 pi 自己的
`<pi agent dir>/trust.json`（`{ "/srv/work/moldplan-center": true }`）。沒寫的話，執行會在問題沒人回答十分鐘後失敗，控制端會收到一則
`notice`（`trust-unanswered`）。`assertSettingsSafe` 對每次執行照樣有效，並拒絕設定連到專案資料夾之外的專案；這個拒絕也是一則 `notice`（`run-refused`）。

pi 啟動的資料夾不只有專案：

- **Herdr 的 worker worktree。** 塔台開一個 worker 時，Herdr 會替它開一個 worktree，位置是 `~/.herdr/worktrees/<repo>/<branch>`（在 macOS 上看到的；Linux 上的路徑還沒確認，第一次用真正的 worker 試跑時要檢查），在專案之外。repo 只要帶有 `.agents/skills`，每個這樣的 worker 都會停在信任詢問上。pi 取的是工作目錄本身或它上面最近的一筆 `trust.json` 項目，所以 worktree 資料夾一筆（`"/home/<user>/.herdr/worktrees": true`，寫成它的真實路徑）就涵蓋所有 worktree，工作資料夾一筆（`"/srv/work": true`）就涵蓋底下所有 repo。先建立 worktree 資料夾，才寫得出它的真實路徑。
- **改過的 `HOME`。** pi 只把 `$HOME/.agents/skills`（pi 程序的 `HOME`）當成使用者自己的。一個程序把 `HOME` 改成別的，再在真實家目錄底下的資料夾（例如 `~/.pi/agent/sessions`）啟動互動式 pi，`~/.agents/skills` 就不再被豁免，會跳出信任詢問。這樣的 pi 要用真實的 `HOME` 啟動，或者信任那個資料夾。

## 6. 被拒絕時看起來像什麼

全部都在 `<pi agent dir>/straw-boss/link/link.log`（JSON lines）和 server 的紀錄裡；對話框和邀請的文字從不出現在其中。

| 紀錄事件 | 意義 |
| --- | --- |
| `policy-refused` | 政策檔沒通過擁有者或寫入檢查，或格式有誤；原因寫在那一行。沒有持有者在跑。 |
| `join-file` 帶 `outcome` | `join.txt` 怎麼結束的。`refused` 會附原因（symlink、擁有者、權限、不是一般檔案、團隊不在政策裡、邀請沒有綁定）。 |
| `join-file-retry` | 中繼站暫時失敗；檔案留著，下一次嘗試在 `waitMs` 之後。 |
| `join-file-stuck` | 檔案刪不掉；同一個檔只報告一次。 |
| `tower-open-failed` | 控制端的訊息找不到塔台，server 也開不了；控制端收到一則 `notice`。 |
| `dialog-oversize` | 問題太大無法轉送（64 KB）；控制端收到一則 `notice`。 |
| `notice` | 送出了一則通知：`key`、`kind` 和單位，絕不含內容。 |
| `drop` 帶 `reason` | 訊息沒通過某項檢查（`dialog-answer-level`、`dialog-answer-digest`、`dialog-answer-here-only`、`unit-status-unexpected`……）。 |

## 7. 控制端看到什麼

控制端的頁面像顯示盟友（ally）一樣顯示這台裝置的基地，附上每個單位的狀態、正在跑的監看（monitor），以及它最後一次的報告（最後一次 `tower_done` 摘要，或最後一次 `tower_send` 給該控制端的文字，截成 4 KB），每分鐘送一次，有變化時也送。只列出位在團隊專案之內的工作區的單位，團隊只分享 `presence` 時一個都不列；裝置超過 3 分鐘沒送東西，就把它最後的單位標成「no status lately」。連結列會收到 `notice`（1 KB），情況有：盟友或主智慧體的執行當掉、逾時或被結束；轉送出去的對話框 30 分鐘沒人回答（只通知一次）；對話框太大無法轉送；塔台開不起來；執行被設定檢查拒絕，或信任詢問沒人回答。清掉通知只影響那一個頁面。
