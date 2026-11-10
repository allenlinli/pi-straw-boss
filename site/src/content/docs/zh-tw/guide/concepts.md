---
title: 概念
description: 成員、主智慧體、塔台、主塔台，以及它們怎麼溝通。
---

pi-straw-boss 為你跨 Herdr 分頁執行的智慧體，建立一套輕量的指揮鏈。
加入是自動的；指揮鏈要靠掙得。

![裝了 pi-straw-boss 的 Herdr：側邊欄的網檢視列出每個工作區、塔台、主智慧體與子智慧體，旁邊是一個正在工作的主智慧體](/pi-straw-boss/docs/img/herdr-window.png)

## 角色

| 角色 | 是誰 | 做什麼 |
| --- | --- | --- |
| **成員** | Herdr 分頁裡的每個 pi，從啟動起就是 | 自己工作。分頁裡有主智慧體時，派出子智慧體之前要先告訴主智慧體。 |
| **主智慧體** | 每個分頁一個：最先升任的成員，或用 `/boss` 接手的你 | 規劃、派出工作者、檢查他們的結果，並在合併或部署之前問你。 |
| **塔台** | 每個工作區一座，在自己的分頁裡並釘在最前面 | 協調自己工作區的各個主智慧體與其他塔台，並為沒有 session 負責的工作開一個帶新主智慧體的分頁。它從不問你。 |
| **主塔台** | 每台電腦一座，不屬於任何專案 | 接收你的指示，並把每項指示交給負責的工作區的塔台。見[主塔台](/pi-straw-boss/docs/zh-tw/guide/head-tower/)。 |

**升任。**
工作變多的智慧體（好幾個步驟、派出工作者、涉及不只一個 app）會呼叫 `boss_promote`。
派出子智慧體的成員會先被自動升任。
一個分頁只有一位主智慧體，除了你用 `/boss` 之外，沒有人能接手它。
主智慧體永不降級；它的 session 結束後，該分頁就沒有主智慧體，直到有成員升任。

**主智慧體的種類。**
主智慧體以 `coordinator`（預設：規劃並派工）、`integrator`（專案的[合併火車](/pi-straw-boss/docs/zh-tw/guide/merge-train/)）或 `standing`（負責某個系統或機器，沒有終點）的身分執行。
它用 `boss_duty` 設定自己的種類，頁面上會顯示。

**塔台何時開。**
智慧體開始互相衝突時，塔台會在自己的分頁裡開啟：有成員派出子智慧體、有智慧體自己升任、某個工作區有兩位成員而另一個工作區已有塔台，或你輸入 `/boss tower`。
主智慧體與塔台同進退：塔台開啟時，會升任每個分頁最早的成員；塔台結束時，會把每位主智慧體退回成員（它們的子智慧體留著）。

**子智慧體。**
用 [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) 啟動的子智慧體，以及 Herdr worktree 工作區裡的 session，都不會加入網。
由啟動它們的 session 代為發言，每個檢視都把它們列在那個 session 底下。

完整規則見[角色與塔台](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/)。

## 溝通

- **`call_tower`**：主智慧體只在三種時機向它的塔台發訊息：`milestone`（有東西落地）、`shared`（在它更動分頁之外的東西之前，例如 port、資料庫、共用分支或部署目標），以及 `blocked`（它在等分頁之外的某人）。
- **`tower_list` 與 `tower_send`**：塔台列出每個工作區的塔台，並寫給其中一座或全部。沒有塔台的工作區，改由它的主智慧體接收，再不然由它的成員。
- **`boss_broadcast`**：發給一個分頁、一個工作區、所有塔台或所有 session 的訊息。
- 每則 `call_tower`、`boss_broadcast` 與 `tower_send` 訊息，開頭都有一段由程式寫的標頭：誰發的、什麼角色、發給誰，以及是否期待回覆。見[塔台之間的對話](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#塔台之間的對話)。

## 塔台知道什麼

- **工作看板。** 主智慧體的看板項目會依它的 todo 清單與名稱自動填入；`board_set` 可以覆寫。塔台用 `board_read` 讀每位主智慧體的項目，不論在這台電腦或隊友的電腦上，所以塔台轉送工作時，知道每位主智慧體做到哪裡。盟友只看得到自動項目的名稱與進度（`<name> (3/5)`），看不到它的任務內容。見[工作看板](/pi-straw-boss/docs/zh-tw/reference/how-it-works/how-it-works/#工作看板)。
- **摘要。** 自上一次執行以來，它的工作區裡的加入、子智慧體啟動與改名；下一次執行讀進來一次後就清掉。
- **它的記憶。** 你的長期指示、你的決定，以及它記下對你的等待事項。見[塔台記憶](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#塔台記憶)。
- **儀表板。** 塔台分頁裡的即時畫面，顯示誰加入了，以及他們與他們的子智慧體正在做什麼。

塔台為某個請求開出的主智慧體，完成時會回報給發送者與塔台，等它裡面沒有東西在跑，塔台就用 `boss_close_main` 把它關掉。

## sb server

每台電腦一個背景程序，也就是 sb server，負責執行塔台、提供瀏覽器檢視，並持有 Straw Link 連線，所以它們都不依賴哪個 pi session 剛好在跑。
任何 pi session 在它沒在跑時都會把它啟動。
`/boss server` 會顯示它，`boss_server` 讓智慧體讀它的 log，或附上理由把它重新啟動。
見 [sb server](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/)。

## 整理工作

- **整齊的分頁。** pi 在分頁裡啟動或退出時，分頁裡的 pane 會重新等分，所以一個個分出去的工作者不會留下一串一半一半的 pane。
- **被留下的子智慧體會被要求回報。** 子智慧體完成後仍開著、而啟動它的 pi 已重新啟動時，會透過 intercom 被要求一次，把最後的報告送到那邊。
- **Herdr 重啟後變成一般 pi session 的子智慧體會被接續。** Straw Boss 會關掉還原出來的 pane，並請啟動它的 session 用 `subagent_resume` 接續那次執行。見[孤立的子智慧體](/pi-straw-boss/docs/zh-tw/reference/how-it-works/orphaned-subagents/)。
- **失控的程序會被停掉。** 工作者的 shell 啟動的東西，會在工作者退出時被停掉。見[程序衛生](/pi-straw-boss/docs/zh-tw/guide/process-hygiene/)。
