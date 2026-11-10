---
title: 快速開始
description: 四個步驟，看網運作起來。
---

1. **在 Herdr 分頁裡開 pi，並交給它工作。** 它會自己加入網。工作變多時，它會自己升任為該分頁的主智慧體，同時開出該工作區的塔台。輸入 `/boss` 可以由你自己接手成為該分頁的主智慧體。
2. **輸入 `/boss status`**，查看每個分頁的主智慧體與各座塔台。
3. **輸入 `/boss tower`**，開啟該工作區的塔台並查看它的儀表板。智慧體開始互相衝突時，它也會自己開。你不需要對它說話。
4. **在任何 session 輸入 `/boss gui`**，在瀏覽器裡看整張網。

![終端機裡塔台的儀表板：這張網的分頁、智慧體與子智慧體，以及其他塔台](/pi-straw-boss/docs/img/tower-dashboard.png)

## 塔台自己運作

sb server 的塔台服務預設是開的。
塔台是一次執行：它因收到的事件而醒來，結束時留下一份交接筆記；`/boss tower <prompt>` 會寫給它。
隊友的 [Straw Link](/pi-straw-boss/docs/zh-tw/guide/straw-link/) 訊息會得到自己的一次盟友執行。

每次執行都從頭開始。
執行結束後還要留著的內容，放在一份小小的記憶裡：你的長期指示、你的決定，以及塔台對你還開著的等待事項。
用 `/boss memory` 讀取與修改，或在 GUI 裡塔台的通訊畫面中操作。
塔台只能提出長期指示或決定的提案；要等你確認才會生效。
見[塔台記憶](/pi-straw-boss/docs/zh-tw/reference/how-it-works/the-sb-server/#塔台記憶)。

塔台只負責轉送與協調，所以可以用比較輕量的模型：在[設定](/pi-straw-boss/docs/zh-tw/reference/configuration/)裡設定 `towerModel`。

## 下一步

- [概念](/pi-straw-boss/docs/zh-tw/guide/concepts/)：誰是成員、主智慧體、塔台與主塔台。
- [瀏覽器檢視](/pi-straw-boss/docs/zh-tw/guide/browser-view/)：地圖、通訊畫面、警示與禪檢視。
- [指令](/pi-straw-boss/docs/zh-tw/reference/commands/)：每個工具與 `/boss` 指令。
