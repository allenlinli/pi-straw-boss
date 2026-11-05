# pi-straw-boss

[English](README.md) | 繁體中文

**很多個 pi 做同一個專案，也不會互相踩到。** pi-straw-boss 讓你在 [Herdr](https://herdr.dev) 各個分頁（tab）裡跑的智慧體（agent）有一條輕量的指揮鏈：每個分頁一個主智慧體（main agent），每個工作區（workspace）一座塔台（tower），還有一張即時的畫面，看得到誰在做什麼。

**[直接在瀏覽器試用](https://wayne930242.github.io/pi-straw-boss/)**：這是用假資料跑的展示頁，不用安裝任何東西。

![標準檢視下瀏覽器裡的稻草網：各座基地的塔台、智慧體和子智慧體，狀態即時更新，頂端有各項計數和等待中的單位](docs/straw-net-gui.png)

<p align="center"><sub><code>/boss gui</code>：在瀏覽器即時看整張網的每個工作區。<a href="docs/straw-net-gui.gif">看它動起來</a>。</sub></p>

<p align="center"><img src="docs/gui-comms.png" width="49%" alt="單位的通訊畫面：即時的對話紀錄、排隊等下一輪的訊息、待辦清單、背景 Monitor，以及附有文件和已派出子智慧體的單位檔案"> <img src="docs/gui-alert.png" width="49%" alt="警示對話框裡是單位正在等的問題，可以直接在瀏覽器回答，有選項可選、可以加註"></p>

<p align="center"><img src="docs/gui-geek.png" width="49%" alt="極客檢視的地圖：黑底、等寬字、高對比，每個單位的狀態以 [WORK]、[WAIT?]、[ERR!] 這類標籤標示"> <img src="docs/gui-settings.png" width="49%" alt="設定頁：這個裝置的檢視（自動、標準或極客）、提醒、音效與音量、語言，下方是手機與裝置、團隊、伺服器各區"></p>

<p align="center"><img src="docs/gui-phone-map.png" width="220" alt="手機上的地圖：頂端、每座基地和每個分頁各有一個 ⋯ 選單，已完成的子智慧體有「Dismiss」按鈕"> <img src="docs/gui-phone-comms.png" width="220" alt="手機上的單位通訊畫面：對話紀錄佔滿畫面，排隊訊息、待辦和 Monitor 收合在輸入框上方，單位檔案在「Info」後面"></p>

<p align="center"><sub>單位的通訊畫面、可以直接在瀏覽器回答的問題、極客檢視、每個裝置自選檢視的設定頁，以及同一個頁面在手機上的樣子。塔台記在你身上的等待事項就在原處回覆：在它的對話框（或塔台卡片上）按「去處理」展開輸入框，按 Enter 就送給塔台。</sub></p>

**禪（Zen）** 是第三種檢視，給你在回應這張網、而不是指揮它的時候用。有東西在等你時，整個畫面只放那一件事：沒有地圖，也不顯示還排著幾件。你回答、取消或跳過（「晚點再說」）之後，會有一次呼吸般的停頓，再換下一件。塔台記在你身上的等待事項（只有你能決定的事）自己是一張卡片：按「去處理」會在卡片上直接展開輸入框，按 Enter 或「送出」把你的話交給塔台，卡片隨一聲木魚離開；「略過」把這則等待丟掉，Esc 把輸入框收起並保留草稿。標準檢視裡放在 Link 按鈕、Wi-Fi 通知和塔台通知的四件事，在禪裡也各是一張卡片：隊友的塔台向這台電腦要的**確認**（允許或拒絕，附上工具的完整參數）、Straw Link 盒子**轉過來的對話框**、**配對請求**（輸入手機上顯示的號碼，再按允許或拒絕），以及塔台提出的**記憶提案**（確認或駁回）。它們呼叫的是和標準檢視同一組函式，什麼時候算結束由伺服器決定，已配對的手機只有它在標準檢視裡原本就有的權限（沒有配對請求卡片：那是這台電腦自己決定的事）。加入團隊的請求仍留在標準檢視。一個對話框有好幾個問題時，一次只清楚地顯示一題：你正在回答的那題展開、清晰，其餘收成一行淡淡的字（題目，答了就接著你的答案），捲動或滑動、選好答案、按 Tab 或點一下那一行就移到下一題。沒有東西在等時，畫面是一個呼吸的圓圈和一句正念的話，每次進入禪都從這裡開始。用 `[` 或 `]` 可以挑一個 session 來陪，畫面會換成它的即時紀錄和輸入框；清單繞完一圈會回到呼吸圓圈，⌘K 裡的「回到呼吸」也能隨時回去。不會自動放一個 session（包括塔台）在那裡。按一次 Esc 會取消畫面上的問題，不能取消的卡片則是跳過；連按兩次 Esc（或選單最後一列）回到標準檢視。右上角的選單還有語言、檢視、音效與音量，旁邊的按鈕可以讓頁面全螢幕。回答之後留下終端機步驟的選項（robot_hand 的「放進我的 prompt」或新的 Herdr 窗格）會在禪裡面出現一張墨色的小卡片讓你完成它，你的 Enter 送出或窗格關閉時卡片自己消失；卡片上的「完整終端機」會在禪裡打開整個終端機，右上角有「回到禪」。**按鍵。** Enter 或空白鍵可以提早結束呼吸停頓（點一下畫面也行）；Esc 回答或跳過畫面上的卡片，600 毫秒內再按一次 Esc 回到標準檢視（選單開著時 Esc 只關選單；輸入框裡有字時只是離開輸入框）。終端機在使用中時頁面不攔 Esc，Shift+Esc 可以讓鍵盤離開終端機。**H** 在卡片上展開「前情」，也就是這個 unit 的 session 紀錄，唯讀地顯示在卡片裡，展開時仍然可以回答；再按 H 或 Esc 收起。`[` 與 `]` 在你能對話的 session 之間切換身邊陪著的那一個。**⌘K**（不在 Mac 上是 Ctrl+K）打開指令面板，列出頁面的動作和右上角選單的選項。沒有東西在等時，頂端有一行淡淡的字說明幾個 unit 在工作、幾個閒著，不會數還在等的。滑鼠移動時會留下淡淡的漣漪。**音效**跟隨設定頁的「音效」開關（預設關）與音量：待辦出現時是一聲柔和的頌缽，完成時是一聲木魚，出錯時是低一點的缽聲；選單裡的「試聽音效」可以先聽。用 `/boss gui view zen` 把它設成預設，或在裝置的設定頁自己選。音樂由你自己放：把音檔（mp3、m4a、ogg、wav、flac 等）放進 `~/.pi/agent/straw-boss-music/`，禪的右上角就會出現 ♪，循環播放，旁邊的 ⌄ 可以選曲（有兩首以上才出現）；資料夾裡沒有檔案就不會出現 ♪。每次顯示禪時都會重讀資料夾，曲子播完前會與自己交叉淡入淡出，所以循環沒有空檔。手機上要先點一下才會出聲（在那之前 ♪ 寫「點一下播放」，手機鎖屏之後也會再次這樣寫），頁面被藏起來時音樂暫停，靜音開關也會讓它靜音。「減少動態效果」開啟時畫面不動，系統的強制色彩模式也會被遵守。

<p align="center"><img src="docs/gui-zen-item.png" width="49%" alt="禪檢視裡的一件待辦：墨色畫面上是 ops-main 的 robot_hand 問題，選項是一行行前面有小圓點的字，下方有「晚點再說」"> <img src="docs/gui-zen-idle.png" width="49%" alt="沒有東西在等時的禪檢視：用 ] 挑來陪的 session，有它的即時紀錄和輸入框"></p>

<p align="center"><img src="docs/gui-zen-alone.png" width="49%" alt="沒有東西在等、也沒有 session 可陪的禪檢視：一個呼吸的圓圈和一句正念的話"> <img src="docs/gui-zen-menu.png" width="49%" alt="在待辦上打開右上角選單的禪檢視：語言、檢視、音效與音量，以及回到標準檢視"></p>

<p align="center"><img src="docs/gui-phone-zen-item.png" width="220" alt="手機上的禪檢視，一件待辦：問題和選項佔滿畫面"> <img src="docs/gui-phone-zen-idle.png" width="220" alt="沒有東西在等時，手機上的禪檢視：挑來陪的 session 的紀錄和輸入框"> <img src="docs/gui-phone-zen-menu.png" width="220" alt="手機上打開右上角選單的禪檢視"> <img src="docs/gui-phone-zen-wait.png" width="220" alt="手機上的禪檢視，塔台的一則等待：問題、打了一句回覆的輸入框，下方是送出、略過和晚點再說"></p>

<p align="center"><img src="docs/gui-zen-wait.png" width="49%" alt="禪檢視裡塔台的一則等待：塔台和基地名當標題、問題、細線下打了一句回覆的輸入框，以及送出、略過和晚點再說"> <img src="docs/gui-wait-answer.png" width="49%" alt="標準檢視裡塔台等待事項的對話框：問題、打了一句回覆的輸入框、送出、前往塔台通訊的連結、稍後和略過"></p>

<p align="center"><img src="docs/gui-zen-history.png" width="49%" alt="打開「前情」的禪檢視：卡片裡是這個 unit 的 session 紀錄，問題的選項仍然可以回答"> <img src="docs/gui-zen-palette.png" width="49%" alt="在陪伴的 session 上打開指令面板（⌘K）的禪檢視，頂端有工作中與閒著的 unit 數的淡淡一行"></p>

<p align="center"><img src="docs/gui-zen-music.png" width="49%" alt="有音樂資料夾時的禪檢視：右上角的 ♪ 開關與打開的曲目清單"></p>

<p align="center"><img src="docs/gui-zen-link.png" width="49%" alt="禪檢視裡隊友的塔台向這台電腦要的確認：誰在問、那句話、工具的參數（沒有框的淡色字）、允許和拒絕，下方是晚點再說"></p>

<p align="center"><sub>禪：一次一件待辦、沒東西等時陪著的 session、沒有 session 時的呼吸圓圈、右上角選單、前情、指令面板、音樂、在卡片上回覆塔台的等待、在卡片上回覆隊友的確認，以及同樣的畫面在手機上的樣子。</sub></p>

**主塔台（head tower）** 是唯一不屬於任何專案的塔台。你和它只有一場很長的對話：在標準檢視有它自己的一頁，在禪檢視則是呼吸圓圈下方的幾行字。它判斷每件事該由哪個工作區處理，轉給那個工作區的塔台，那個工作區還沒有塔台就先替它開一座。它自己不做事；塔台回覆之後，它再用一行話告訴你。禪檢視裡，它最近說的話會隨時間慢慢淡去（滑鼠移上去就看得清楚，按 **H** 或往上滑可以看全部對話），輸入框平時只是一條細線，點一下或按 Enter 才展開。按 **Esc** 或點空白處，這幾行字會先退下、正念句回來；主塔台自己主動說的話不會把它叫醒，按 Enter 或 **H**、它回覆你、或它有事要問你時才會回來。

<p align="center"><img src="docs/gui-head.png" width="49%" alt="標準檢視裡主塔台的頁面：標題有皇冠，對話裡有兩則轉給 Harbor API 和 Lighthouse Web 塔台的紀錄和一則回覆，進行中和已回覆的轉交以標籤列在下方，最下面是輸入框"> <img src="docs/gui-zen-head.png" width="49%" alt="禪檢視裡的主塔台：呼吸圓圈下方是它最近說的幾行字，其中有一行是 Lighthouse Web 塔台的回覆，再下面是一條細線的輸入框，寫著按 Enter 和主塔台說話"></p>

<p align="center"><img src="docs/gui-zen-head-open.png" width="49%" alt="輸入框展開、已打了一段草稿的禪檢視：主塔台的幾行字在滑鼠底下是清楚的"> <img src="docs/gui-phone-zen-head.png" width="220" alt="手機上的禪檢視：主塔台對話的兩行字、「全部對話」連結，和收起的輸入框"></p>

<p align="center"><sub>主塔台：它的頁面、禪檢視圓圈下方的幾行字、展開的輸入框，以及手機上的樣子。</sub></p>

![裝了 pi-straw-boss 的 Herdr：側邊欄的網路檢視列出每個工作區、塔台、主智慧體和子智慧體，旁邊是一個正在工作的主智慧體](docs/herdr-window.png)

<p align="center"><sub>側邊欄開著網路檢視的 Herdr。</sub></p>

![塔台在終端機裡的儀表板：這張網的分頁、智慧體、子智慧體，以及其他塔台](docs/tower-dashboard.png)

## 為什麼需要它

同一個專案跑上幾個智慧體，它們很快就會互相干擾：兩個 dev server 搶同一個 port、兩條分支改同一個 migration，而且沒有一個智慧體知道其他智慧體存在。pi-straw-boss 讓它們能找到彼此、互相協調，不需要排程器，也不用多架一個服務。

- **每個人都會加入。** Herdr 裡的每個 pi 一啟動，就以成員（member）身分加入所在分頁的網，不用問，也不用記。
- **每個分頁一個主智慧體，靠升任產生。** 工作變多的智慧體呼叫 `boss_promote`，或在第一次派出子智慧體（subagent）時自動升任。一個分頁只有一個主智慧體，除了你用 `/boss` 接手以外，沒有人能取代它。
- **每個工作區一座塔台。** 智慧體開始互相干擾時，塔台會在自己的分頁開起來，固定排在最前面：成員派出子智慧體（它會先升任）、另一個工作區已經有塔台而這個工作區有兩位成員、有智慧體升任，或你輸入 `/boss tower`。主智慧體和塔台同進退：塔台開起來時，會把每個分頁最早的成員升為主智慧體；塔台結束時，每個主智慧體都變回成員（它們的子智慧體留著）。塔台負責協調各個主智慧體和其他塔台；沒有 session 負責的工作，它會開一個分頁、啟動新的主智慧體來處理。你不用跟它說話。
- **即時儀表板**在塔台裡：誰加入了，他們和他們的子智慧體正在做什麼。
- **塔台之間可以直接溝通。** 塔台能列出每個工作區的塔台（`tower_list`：訊息會送到誰、各分頁在做什麼），也能對其中一座或全部發訊息（`tower_send`）；沒有塔台的工作區，訊息改送它的主智慧體，沒有主智慧體就送成員。`call_tower`、`boss_broadcast`、`tower_send` 的每則訊息開頭都有一行程式寫的標頭：誰送的、什麼角色、送給誰、要不要回覆（[細節](docs/how-it-works.md#talking-between-towers)，英文）。
- **你自己的主塔台。** 一座不屬於任何專案的塔台：你在 GUI（它自己的一頁，或禪檢視圓圈下方的幾行字）或用 `/boss head` 和它說話，它和你保持一場跨越多次執行的長對話，把每件事轉給該處理的工作區的塔台（用 `tower_send`，必要時先替那個工作區開一座塔台），塔台回覆之後用一行話告訴你。它只有查詢和轉交用的塔台工具，只聽你的話和對它自己轉交的回覆（[細節](docs/how-it-works.md#the-head-tower)，英文）。
- **工作看板。** 主智慧體的看板由它的待辦清單和名稱自動填入（`board_set` 可覆寫）；塔台讀每個主智慧體的項目（`board_read`），本機的，加上 Straw Link 團隊中隊友電腦上的，這樣塔台分派工作時知道各主智慧體做到哪（[細節](docs/how-it-works.md#the-work-board)）。
- **塔台會關掉自己開的主智慧體。** 塔台替請求開出的主智慧體做完後，向發話者和那座塔台各回報一次；塔台確認裡面沒有東西在跑，就用 `boss_close_main` 把它關掉（[細節](docs/how-it-works.md#closing-an-opened-main)，英文）。
- **每個專案一列合併火車。** 在 `apps.json` 開啟它的專案，由一個整合者（integrator）主智慧體接收各協調者的分支，每條分支是一節車廂。整合者把一列火車的車廂合在一起，請人審查一次合併後的結果，重型的檢查（lint、build、完整測試）每列火車只跑一次，不必每條分支各跑一次。app 有列出後續階段時，整合者接著部署這列火車：`auto` 的目標直接部署，設定檔本身就是你的長期授權；`strict` 的目標，要有你對那個目標的授權才部署。最後為每列火車開一頁審查頁給你驗收，你留言的車廂退回給它的協調者。Straw Boss 只規定流程，所有具體的檢查都寫在專案自己的 skill 裡（[細節](docs/how-it-works.md#merge-train)，英文）。在某台電腦上不想用合併火車時，在 `herdr server` 與其 session 的環境設 `STRAW_BOSS_INTEGRATION=off`，或在 `<agentDir>/straw-boss/config.json` 設 `"integration": "off"`（`<agentDir>` 是 `PI_CODING_AGENT_DIR`，沒設就是 `~/.pi/agent`；兩者並存時以環境變數為準；讀不懂的設定一律視為關閉並提示一次；桌面版 `STRAW_BOSS_DESK=1` 預設關閉，要明確設為 on 才會開）：沒有主智慧體或塔台會擔任整合者，合併與部署都要等你的話，`apps.json` 裡的 `integration` 也會被忽略。
- **給塔台的摘要**：自塔台上一輪以來，工作區裡有誰加入、啟動了哪些子智慧體、誰改了名字；塔台下一輪會讀進來一次，讀完就清掉（[細節](docs/how-it-works.md#the-towers-digest)）。
- **瀏覽器畫面** `/boss gui` 看得到整張網：每個工作區是一座基地，裡面有塔台、智慧體和子智慧體，畫面會動，但只能看。點基地可以放大，點單位可以把它的對話當成即時通訊紀錄來讀；在等你回覆的單位會排成警示，按空白鍵開下一則，按 F 放大最上面的對話框，按 Esc 關掉它（打字時都不會觸發）；回答問題也可以只用鍵盤：方向鍵選項目，Tab 依序走過每一題自己的答案框和備註、再換到下一題，Enter 確認並跳到下一題。頂端齒輪「設定」裡有兩個開關：單位在等你、出錯或完成時，一個會跳系統通知，一個會播音效；已完成的單位另外排在自己的清單裡，可以一個一個清，也可以一次全清；地圖上已結束的子智慧體也可以一個一個移除，或用位置列旁的「移除已完成」一次全移除。單位的通訊畫面也會列出它在背景跑的 Monitor，出錯或太久沒輸出的 Monitor 會列進標頭的「通知」（只有在等你回答的單位才會跳出醒目的警示，出錯和完成都只是安靜的通知）；自己閒置、但它的子智慧體在工作或等待，或它的 Monitor 還在跑的單位，會顯示成帶光暈的「指揮中」；只在等 Monitor 跑完的單位，備註會用紅字顯示「監看中」。在桌面上點進單位的終端機，就能直接用鍵盤操作它。如果一個答案的下一步要在終端機進行（robot_hand 的「放進提示列」和開新 pane 的選項），畫面會出現一張小卡片讓你完成它：指令、窗格最後幾行、一行輸入（要輸入密碼時會自動遮住）和一個按鈕，另有連到完整終端機的連結，給 ssh 和 vim 這類程式用。畫面有英文和正體中文，預設跟隨瀏覽器語言，也可以從頂端「設定」裡的語言選單切換。地圖最後一張「＋新基地」會在選定的資料夾開一座基地，裡面先有一位成員、沒有塔台。沒有塔台的基地只能加成員（基地上的「＋成員」開在新分頁，小隊上的開在該小隊旁），等成員自己升格時才會開塔台；有塔台的基地只能加主智慧體（「＋主智慧體」，各開在自己的分頁）。在 session 的輸入框貼上、拖進或用「＋」選的檔案（最多 20 MB）會存到私有的暫存資料夾，路徑放進訊息。「×」會在確認後關掉一座基地、一個小隊，或（在它自己的畫面裡）一個單位：每個智慧體像 `/quit` 一樣結束 pi，再關掉它的 pane、分頁或工作區；只要其中一個拒絕，就什麼都不關。開啟表單都可以先填第一句指令；資料夾用 Finder 式的欄位挑選（可以「新增資料夾」，基地預設以資料夾命名），只能在家目錄以下，不會列出點開頭的資料夾（Windows 上也不列出帶「隱藏」或「系統」屬性的資料夾，例如 AppData 和舊的設定檔連結）。單位開啟時，部署面板會列出實際的步驟（建立、啟動、加入網、送出第一句話）和每一步的耗時，某一步失敗時會指出是哪一步、為什麼。pi 啟動前要先確認專案信任（資料夾裡有 `.pi/` 設定、擴充、skill 或 MCP 伺服器）時，GUI 也會跳出警示，列出資料夾、信任後會載入什麼，以及「信任」「這次信任」「不信任」（終端機也能回答，先答的算數；配對的手機也能回答；開啟中的部署面板會直接顯示這個問題）。
- **無人值守裝置**是沒有人坐在前面的電腦（建置機、伺服器），透過 Straw Link 接隊友電腦送來的工作：它以 sb server 當連線持有者，沒有開機時啟動的 pi session，由控制端在 GUI 邀請它加入（[設定方式](docs/unattended-device.zh-TW.md)；[English](docs/unattended-device.md)）。多位開發者共用一台時，單位的問題和通知只送給派出它的控制端和團隊的管理員；離開團隊或失去 `dispatch` 權限的裝置，它在這台機器上的工作會被結束。
- **廣播**給一個分頁、一個工作區、所有塔台（沒有塔台的工作區改送主智慧體或成員），或所有 session。
- **分頁保持整齊。** pi 在分頁裡啟動或結束時，分頁裡的 pane 會重新平均分配，一個一個切出來的 worker 就不會留下一長串對半切的窄 pane。
- **斷線的子智慧體會被提醒回報。** 子智慧體做完後還開著，但開出它的 pi 已經重開、收不到它的結果時，它會收到一則 intercom，請它把最終報告送回去，只會送一次（[運作方式](docs/how-it-works.md#orphaned-subagents)）。
- **Herdr 重啟後被還原成一般 pi 的子智慧體會被接回來。** Herdr 重啟時（`resume_agents_on_restore`）會在每個子智慧體的 pane 裡重開一個普通的 `pi --session`，少了讓它成為子智慧體的設定，結果永遠送不回來。Straw Boss 會關掉那個被還原的 pane，並請開出它的 session 用 pi-herdr-agents 的 `subagent_resume` 重新接手；受管 worktree 的子智慧體則保留原 pane，只回報給開出它的 session；重啟時剛好被切斷回合的子智慧體會被告知一次，先確認現況再繼續（[運作方式](docs/how-it-works.md#subagents-a-herdr-restore-brought-back-plain)，英文）。
- **Herdr 側邊欄的網路檢視。** 一個選用的 plugin 會把 Agents 清單排成網的樣子：塔台在前，每個子智慧體排在開出它的人底下。預設開啟，按一個鍵就能切換。
- **清理閒置的 worktree pane。** 另一個選用的 plugin 會關掉智慧體在 worktree 工作區留下的 pane，移除乾淨且沒有東西在用的 checkout，並保留你釘選的工作區。

## 安裝

```bash
pi install npm:pi-straw-boss
```

### 需求

- pi 要跑在 [Herdr](https://herdr.dev) 0.9.4 以上。
- Herdr 的 pi 整合（`herdr integration install pi`）：沒有它，Herdr 不會替窗格標出 pi session，該 session 就無法加入網；每個 session 啟動 20 秒後若發現缺少，會警告一次。
- [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.18.1 以上：網的頻道、訊息，以及 GUI 轉送對話框，都是透過它，sb server 的連線也是；版本較舊或沒裝時，sb server 起不來（`start-error.json` 與 `boss_server status` 會說明）。
- Windows 支援是實驗性的：擴充套件在 Windows 上透過 Herdr 的 named pipe 連線，側邊欄 plugin 用 `PATH` 上的 `node` 執行，worktree reaper 只支援 macOS 和 Linux，專案信任（project trust）的轉送則要求 pi 的 agent 資料夾位在你的使用者設定檔（user profile）之內，否則 pi 照舊在終端機裡詢問（[差異在哪](docs/how-it-works.md#windows)，英文）。

### 支援的套件

下面的套件都可裝可不裝。裝了，Straw Boss 會自動接上；沒裝，其他功能照常運作。

| 套件 | Straw Boss 怎麼用它 |
| --- | --- |
| [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | 子智慧體會顯示在開出它的 session 底下，塔台面板、側邊欄和 GUI 都看得到；成員派出子智慧體時，會升格成主智慧體，塔台也會跟著開。 |
| [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.13 以上 | `ask_user_question` 問卷可以在 GUI 作答或取消（「取消」按鈕，等同終端機裡按 Escape），等待作答的問卷也會讓該單位顯示為等待中。 |
| [pi-robot-hand](https://www.npmjs.com/package/pi-robot-hand) 0.3.0 以上 | `robot_hand` 選單可以在 GUI 作答。 |
| pi-code（hooks 擴充，需含它的對話框事件） | 它的 hook 確認（「Allow bash?」：允許或拒絕，在任何被攔下的工具呼叫之前）可以在 GUI 作答。 |
| [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 以上 | session 展示的文件會開在它的通訊畫面旁邊：HTML 放在沙箱框架裡，表單送出的內容會回給 agent；文字檔只能讀。 |
| [@juicesharp/rpiv-todo](https://www.npmjs.com/package/@juicesharp/rpiv-todo) 2.13 以上 | session 的待辦清單會顯示在 GUI 的輸入框上方，內容從 session 檔讀取。 |
| [straw-boss](https://github.com/wayne930242/straw-boss)（Claude Code 和 Codex） | Claude Code 或 Codex 的主智慧體 session 會透過 straw-boss 隨 session 啟動的小型 sidecar 行程加入分頁的網：預設是成員，登記成 orchestrator 後升成主智慧體。它會出現在塔台儀表板、側邊欄和 GUI（帶智慧體徽章，GUI 無法對它輸入），可以用 `straw-net.py` 呼叫塔台、廣播，網上的訊息會以 `[straw net …]` 開頭的一行打進它的 pane（[說明](docs/how-it-works.md#from-claude-code-or-codex)，英文）。 |

任何 extension 的 `select` 和 `confirm`（例如 `mp-infra` 的指令審查）也可以在 GUI 作答，不必改動那個 extension：Straw Boss 把它們包在 pi 共用的 `ctx.ui` 上，照常打開 pi 自己的對話框，同時轉送同一個對話框，先答的算數。`select` 和 `confirm` 都可以從配對的裝置作答，也都可以用問題卡片上的「取消」按鈕取消（效果等同終端機裡按 Escape：select 沒有選擇，confirm 回答「否」）；但每個選項都只限這台電腦頁面使用的對話框（例如 `/boss` link 核准、`gui rotate`），配對的裝置不能取消。`input`、`editor`、`custom` 完全不碰，它們和 pi-ask-user 的 `ask_user` 在 GUI 裡只能看，可以一鍵切到終端機回答。

## 快速開始

1. 在 Herdr 分頁裡開一個 pi，交給它工作。它會自己加入網；工作變多時，它會把自己升成這個分頁的主智慧體，同時開出工作區的塔台。你可以用 `/boss` 接手。
2. 輸入 `/boss status`，看每個分頁的主智慧體和各座塔台。
3. 輸入 `/boss tower`，開啟工作區的塔台、看它的儀表板。智慧體開始互相干擾時，它也會自己開起來。
4. 在任何一個 session 輸入 `/boss gui`，就能在瀏覽器看整張網。

塔台只負責轉送和協調，所以可以用比較輕的模型：在 `~/.pi/agent/straw-boss/config.json` 設定 `towerModel`（[運作方式](docs/how-it-works.md#how-it-works)）。sb 伺服器的塔台服務預設開啟：塔台是一次次的執行，有事件送到才醒來，結束時留下一份交接說明（`/boss tower <提示>` 會寫給它）；隊友透過 Straw Link 送來的訊息，則由一次獨立的盟友執行（ally run）處理。每次執行都從頭開始；必須跨越執行留下來的東西（你的長期指示和決定，以及塔台還在等的事），放在一份小小的記憶裡，你用 `/boss memory` 或 GUI 裡塔台的通訊畫面讀取、修改。塔台只能提議長期指示或決定，要你確認才生效（[運作方式](docs/how-it-works.md#tower-memory)，英文）。在同一個檔案設 `{ "towerRuns": { "enabled": false } }`，就會改回常駐的塔台（[運作方式](docs/how-it-works.md#the-tower-service-b4)，英文）。

## 工具與指令

| 名稱 | 作用 |
|---|---|
| `boss_promote` | 成為這個分頁的主智慧體（分頁已經有主智慧體時會被拒絕）。 |
| `boss_status` | 列出各個主智慧體、這個工作區的塔台，以及其他塔台。 |
| `call_tower` | 傳訊息給這個工作區的塔台，或別的工作區的塔台（訊息開頭有標頭）。`why` 說明原因：`milestone`（完成一個階段）、`shared`（要動共用的東西之前）、`blocked`（卡住或在等），主智慧體只在這三個時機呼叫塔台；只是通知時可設 `reply: false`。 |
| `boss_open_main` | 只有塔台能用：替沒有 session 負責的請求開一個分頁，啟動新的主智慧體。 |
| `boss_close_main` | 只有塔台能用：關掉這座塔台自己開的主智慧體，裡面沒有東西在跑時才會關。 |
| `tower_list` | 只有塔台能用：列出每個工作區的塔台、訊息會送到誰、它的狀態，以及各分頁在做什麼。 |
| `tower_send` | 只有塔台能用：傳訊息給另一座塔台（用工作區 id 或名稱），或全部塔台。 |
| `board_read` | 只有塔台能用：看工作看板，也就是各主智慧體正在做什麼、做到哪；本機的，加上 Straw Link 團隊中隊友電腦上的。 |
| `board_set` | 分頁的主智慧體用：覆寫自己的看板項目（一行目前的工作，加最多 8 個清單項），用 `auto: true` 交還給依待辦清單和名稱的自動填入，或用 `clear: true` 在工作做完或擱置時刪掉它。 |
| `boss_broadcast` | 傳訊息給一個分頁、一個工作區、所有塔台，或所有 session（訊息開頭有標頭）。 |
| `boss_server` | 查看 sb 伺服器（伺服器停著時 status 也能用）、讀它的記錄（最多 200 行），或附上理由重新啟動它。你刻意停掉伺服器時會被拒絕，每分鐘最多一次，遠端回合裡也一律拒絕。 |
| `boss_rename` | 用一個短語替這個 session 命名，說明它現在在做什麼；net 與 GUI 會顯示它，主智慧體的分頁也會改成這個名稱。主智慧體換工作時會呼叫它。 |
| `/boss` | 接手成為這個分頁的主智慧體。 |
| `/boss status`、`/boss tower` | 顯示狀態；開啟塔台並切換過去。 |
| `/boss memory [-w workspace]`、`/boss memory confirm P1`、`reject P1`、`add standing\|decision <內容>`、`edit S1 <內容>`、`delete D1`、`resolve W1` | 在 pi 裡讀取與修改塔台的記憶（常駐指示、決定、等待），並回應塔台的提議；塔台只能提議，你確認才生效。GUI 的記憶面板是同一個操作。見 [Tower memory](docs/how-it-works.md#tower-memory)。 |
| `/boss server`、`/boss server stop`、`/boss server restart [理由]` | 顯示 sb 伺服器，停著時順便啟動它；刻意停掉它（先確認；之後只有 `/boss` 指令能再啟動它）；在同一個埠重新啟動它（先確認）。GUI 網址不變，開著的頁面會自己重新連上。見 [sb 伺服器](docs/how-it-works.md#the-sb-server)（英文）。 |
| `/boss server logs [n]` | 顯示 sb 伺服器記錄的最後 `n` 行（預設與上限都是 200），和 `boss_server` 工具的 `logs` 相同。 |
| `/boss close` | 結束這個 session，並關掉它的 pane。 |
| `/boss close all` | 讓這個基地的塔台、主智慧體和成員結束，連同 shell 一起關掉，不存 stash。會先用 stash 的同一套檢查；有會遺失的東西（正在跑的回合、排隊中的訊息、對話框、Monitor、子智慧體、前景有程式的 shell）就什麼都不關，並列出所有原因。其他基地完全不碰。 |
| 網頁上的「收起」「已收起」「接回」 | 基地的「收起」以基地名稱收起它；上方的「已收起」列出收起的基地，按「接回」打開。基地的「關掉」會先檢查，和 `/boss close all` 一樣。 |
| `/boss stash [名稱]`、`/boss pop [名稱]` | 把整個基地（塔台、主智慧體、成員和閒置的 shell）收起來並關掉；之後再打開，每個 pi 都從自己的 session 檔接回原本的角色。只要有接回後會遺失的東西就拒絕並說明原因：正在跑的回合、排隊中的訊息、開著的對話框、執行中的 Monitor、子智慧體，或前景有程式在跑的 shell。 |
| `/boss close <名稱\|key>`、`/boss close all <工作區>` | 結束另一個單位、小隊（分頁）或整個基地，結束前在 pi 裡確認（確認畫面會列出誰要結束）。名稱對到不只一個時會列出候選並什麼都不做，名稱前加 `unit:`、`squad:` 或 `base:` 可指定種類。它送到網頁「關掉」用的同一個伺服器路由，所以檢查規則不變。單獨的 `/boss close` 仍是結束這個 session；只有老闆打的指令才有效，塔台執行與盟友執行都碰不到。 |
| `/boss stash [名稱] --workspace <標籤\|id>` | 把另一個基地收起來（先確認），名稱預設為它的標籤。 |
| `/boss dismiss [all\|<名稱>]` | 把已結束的子智慧體從網路上隱藏，全部或依名稱一個，和網頁的「移除」相同。 |
| `/boss open base <資料夾> [名稱]`、`/boss open member [資料夾]`、`/boss open main <資料夾> [提示]` | 網頁的「＋基地」「＋成員」「＋主智慧體」，用打字完成。`<資料夾>` 相對於本工作階段的資料夾（`~` 是家目錄；路徑有空格要加引號）；伺服器仍只接受家目錄底下的資料夾。基地會附一位成員；成員開在本工作階段旁邊（給資料夾則開在它的新分頁）；主智慧體開在本基地的新分頁，可帶提示。新的 pi 若在等專案信任問題，會在 pi 裡問你。 |
| `/boss link [status]`、`/boss link decide <id> approve\|refuse` | 列出本裝置的團隊與成員，以及等待中的加入要求（附短 id），並做網頁的「核准／拒絕」。核准有人值守的裝置時，pi 會顯示團隊、裝置與各組單字：選新電腦螢幕上顯示的那一組（都不是就是拒絕）；核准無人值守的裝置會先確認。id 不存在或不唯一就什麼都不做。已配對的手機能讀、能開單位，但不能決定。 |
| `/boss gui`、`/boss gui stop`、`/boss gui rotate` | 在瀏覽器開啟網（任何 session 都能開，不會加入任何東西）；停止它的伺服器，在哪個 session 都可以。整台機器只跑一個伺服器，網址會保留（見下）：開它的 session `/reload` 之後會重開（網址不變）；跑它的 session 結束時（關掉 pane、離開 pi、當機），另一個還開著的 session 會在幾秒內重開它（網址不變）（塔台優先；pi-straw-boss 版本比伺服器舊的 session 要等約六秒才接手，直到下一個較新的 session 再接回去）；之後才啟動的 session 也會把停著的伺服器重開，即使所有 session 都離開過或機器重開機；版本較新的 session 會接手，但開著的頁面不會自動換成新版：它會顯示「這個網址已失效」，要用 `/boss gui` 重開。網址裡的 token 會跨過重啟保留：伺服器重啟、升級、當機、重開機，或 `/boss gui stop` 之後再 `/boss gui`，都沿用同一個 token（存在 `gui-secrets.json`，連同埠號），開著的分頁會自行重新連線，手機仍維持配對。只有 `/boss gui rotate`（會先確認；換新 token 與 CSRF 密鑰、解除所有手機的配對並開啟新網址）、`gui-secrets.json` 遺失或損毀，或下次啟動時埠號被占用，才會換新 token：舊網址回 403，手機要重新掃 QR code。保留 token 的代價是你選擇接受的：當機或重啟的空檔裡，這台機器上其他帳號若搶先佔用該埠，會看到開著的頁面送出的內容；對空檔不放心時請 rotate。設了 `STRAW_BOSS_DESK=1`（桌面殼自己顯示頁面）時，它不會開瀏覽器，頁面也不顯示設定頁的「手機與裝置」與 Stash。只有 `/boss gui stop` 會讓它維持停止，直到下一次 `/boss gui`；`/boss stash` 和 `/boss close all` 不會把停著的伺服器重開。可以在通訊畫面直接打字給某個 session，或用終端機畫面下方的按鍵面板操作它的終端機，在桌面上也可以點進終端機直接打字；在等回覆的 `robot_hand` 選單、`ask_user_question` 問卷或 pi-code 的 hook 確認，可以在那裡或它的警示裡作答（任何 extension 的 `select` 和 `confirm` 也可以，`confirm` 也可以從配對的裝置作答；其他對話框只能看，要回到終端機回答；`secret_drop` 的機密一律在終端機輸入，任何頁面（本機或 tailnet）都不接受，因為 pi-intercom 的身分是自己申報的，無法驗證）。session 用 [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 以上顯示的文件，會開在它的通訊畫面旁邊：HTML 放在沙箱框架裡，表單送出的答案會傳給智慧體；純文字只能讀。 |
| `/boss gui devices`、`/boss gui unpair <id\|all>` | 列出已配對的手機（id、標籤、Tailscale 或 Wi-Fi、配對與最後使用時間），並解除配對一支（給 id 或 id 的開頭）或全部（先確認）。網址不會變；要換網址是 `/boss gui rotate`。 |
| `/boss gui lan`、`/boss gui lan off`、`/boss gui lan reset` | 不用 Tailscale，讓同一個 Wi-Fi 上的手機連 GUI。預設關閉，要你自己打開。這台電腦會先說明風險，再自己產生憑證：任何人只要從這台電腦複製走它的金鑰，就能對你的手機冒充私有網路上的網站（路由器的設定頁、NAS），直到你從每支手機移除這張憑證為止。所以請在手機的個人熱點上用，或用能讓手機直接連到這台電腦的 Wi-Fi。每支手機安裝一次憑證（從電腦用 AirDrop 或 Quick Share 傳過去，照螢幕說明核對），再掃 QR code 或輸入代碼配對；每支新手機都要你在電腦上輸入它顯示的數字才放行。[運作方式](docs/how-it-works.md#browser-view)（英文）。 |
| `/boss gui view`、`/boss gui view auto\|standard\|geek\|zen` | 顯示或設定 GUI 的預設檢視。設定頁維持「自動」的裝置會顯示這個預設；自己選了標準或極客的裝置保留自己的選擇；預設為 `auto` 時，裝置依自己螢幕的對比設定。已開啟的頁面立即切換，新開的頁面第一個畫面就是預設檢視（頂端有極客檢視、禪檢視和設定頁的截圖）。只有這個指令能設定：任何頁面（包括已配對的手機）都不行。 |
| `/boss gui remote`、`/boss gui remote off` | 透過你的 tailnet 用手機連 GUI（`tailscale serve`，絕不用 Funnel）：掃 QR code 配對（已安裝的 app 則輸入 QR 旁邊顯示的短配對碼），手機配對後的紀錄會保留（從最後一次使用起算 90 天，重啟與 `remote off` 都不影響），直到你在設定頁的「手機與裝置」區解除配對；遠端存取在 stop、`/reload`、換新伺服器之後仍會保持開啟，直到 `remote off`；伺服器重啟後 token 不變，已配對的手機照常使用；GUI 換新 token（`/boss gui rotate`、`gui-secrets.json` 遺失，或埠號被占用）時，舊的配對全部清除（cookie 綁在舊 token 的路徑上），手機要重新配對：瀏覽器掃 QR code，已安裝的 app 輸入配對碼（見下）；關閉時只移除它自己的 serve 設定。serve 指向 GUI 伺服器的第二個 loopback 監聽埠，請求算不算遠端取決於它進來的監聽埠，不看它帶什麼標頭。頁面可以安裝成 app（加入主畫面，或 Chrome 的「安裝」）：app 的起始網址是固定入口 `https://<這台機器>.<tailnet>.ts.net:8443/sb-app/`（沒有 token，只在 tailnet 監聽埠上）：已配對時它會帶你到目前的頁面；沒有配對時（換新 token 後，或 iOS 上 app 有自己的 cookie、在 Safari 掃 QR code 永遠到不了 app），它會顯示 8 個輸入格，輸入 `/boss gui remote` 在 QR code 下方印出的**配對碼**（設定頁的「手機與裝置」區也顯示在 QR code 旁），每格一個字元（貼上整組會自動填滿）。配對碼 8 個字元，顯示成兩組各四個（`ABCD EFGH`，不需要輸入連字號），十分鐘內只能用一次，輸錯五次後作廢，要在這台電腦上重新取得新的才能再試。在這個入口出現之前安裝的 app，舊網址現在也會導向入口。 |
| `node dist/server/cli.mjs up --dir <資料夾> --label <名稱>`（給外殼程式用，不是 pi 指令） | `up` 的桌面步驟，給自己顯示頁面的外殼程式（straw-boss-desk）使用：在啟動 `herdr server` 與執行這個指令的環境都設了 `STRAW_BOSS_DESK=1` 時，它會在 Herdr 的 pi 整合不是最新時安裝，建立外殼的家基地（在該資料夾開一個工作區，記在 `desk.json`，之後以工作區 id 找回），讓 sb server 代替這個工作區的塔台，等 GUI 起來，最後印出一行 JSON，內有 `url`、`workspace`、`pane`、`tower`、`created`、`integration`。重複執行不會多開東西；沒設這個開關時以代碼 2 結束。詳見[桌面模式](docs/how-it-works.md#desk-mode-up---dir)。 |

子智慧體，以及在 Herdr worktree 工作區裡的 session，都不會加入網，由開出它們的 session 代表它們。不在 Herdr 裡時，這個擴充套件什麼都不做。

## 側邊欄的網路檢視

[`herdr-plugin/`](herdr-plugin) 裡有一個選用的 Herdr plugin，會把側邊欄的 Agents 清單變成網路檢視。
它先列出主塔台（head tower）所在的工作區（主塔台存在時）；每個工作區裡先列塔台，再列各分頁的主智慧體和成員，每個子智慧體緊接在開出它的 session 底下，即使它在 worktree 工作區裡也一樣。
Herdr server 啟動時這個檢視就會打開，按一個鍵可以關掉，再按一次打開。
pi-straw-boss 會寫入排序鍵（`sb_order`）、角色標記（`sb_mark`），子智慧體另外有樹狀分支（`sb_indent`）和它的名稱（`sb_name`），網路檢視和你自己的側邊欄列設定都可以用。
需要 Herdr 0.9.5 以上和 node。
在 Windows 上，切換動作是 `wayne930242.straw-boss.net-windows`（Herdr 要求動作 id 在各平台之間不能重複）。

<p align="center"><img src="docs/sidebar-net-view.png" width="308" alt="Herdr 側邊欄的網路檢視：每個工作區的塔台排第一，前面是訊號塔圖示；每個主智慧體佔兩列，有星號和它的分頁名稱；每個子智慧體以樹狀分支排在開出它的 session 底下"></p>

<p align="center"><sub>網路檢視裡每個智慧體的角色標記。<a href="docs/how-it-works.md#sidebar-net-view">運作方式</a>有顯示這些標記的側邊欄列設定。</sub></p>

從原始碼連結 plugin，再到 Herdr 的 `config.toml` 綁一個鍵：

```bash
herdr plugin link /path/to/pi-straw-boss/herdr-plugin
```

```toml
[[keys.command]]
key = "prefix+alt+n"
type = "plugin_action"
command = "wayne930242.straw-boss.net"
description = "toggle the straw net view"
```

執行 `herdr server reload-config` 載入這個鍵；要移除 plugin 就執行 `herdr plugin unlink wayne930242.straw-boss`。
也可以不用原始碼，改用 `herdr plugin install wayne930242/pi-straw-boss/herdr-plugin` 從 GitHub 安裝。
[運作方式](docs/how-it-works.md#sidebar-net-view)列出了所有標記，也有一段側邊欄列設定，讓 Herdr 原本的檢視也能顯示每個成員的角色。

## 閒置的 worktree pane

另一個選用的 Herdr plugin 放在 [`herdr-reaper/`](herdr-reaper)，專門清理 worktree 工作區裡智慧體跑完留下的東西。
只處理 worktree 是 linked git worktree 的工作區（不管它叫什麼名字）：智慧體結束、pane 的 shell 閒置之後，就關掉這個 pane，但絕不關掉有焦點的 pane。
Herdr 接著會關掉分頁和工作區，plugin 再在 `git status` 乾淨、而且沒有別的東西還在用它（沒有別的 pane 在裡面工作，也沒有別的工作區開在同一個 checkout）時移除這個工作區的 checkout。
pi-herdr-agents 建立的 worktree 會留著，直到它的父 session 用 `worktree_remove` 移除；父 session 只要還開在某個 Herdr pane 裡就一直留著，沒有開著時則等它靜默 72 小時（`retain_idle_hours`）；任何有你的行程以它為工作目錄的 checkout 也一樣不動。
git 忽略的檔案（`.env`、`node_modules`、快取、本機資料庫）不算變更，所以會跟著 checkout 一起被刪掉。
分支一律保留；有未提交變更的 checkout 也留著，原因寫在 plugin 日誌裡。
含已初始化 submodule 的 checkout，只有在每個 submodule（含巢狀的）都沒有未提交或未追蹤的檔案，且 HEAD 已被某個 remote-tracking ref（或主儲存庫自己那份 module 的 ref）包含、不會遺失任何 commit 時才會移除：reaper 先跑 `git submodule deinit --all`，刪掉 worktree 的 `.git/worktrees/<id>/modules`（有它在，git 不肯移除 worktree），再跑不帶 `--force` 的 `git worktree remove`。不符合就保留，日誌會寫出是哪個 submodule、為什麼；若移除做到一半失敗、留下 git 已不再追蹤的檔案，日誌會寫「half-removed」並指出該目錄，由你自己刪除。
Herdr 為了把 worktree 歸在底下而替主 checkout 開了一個純 shell 工作區時，plugin 會記住它；該 repo 的 worktree 工作區全部收掉後，若它只剩閒置的 shell（沒有智慧體、沒釘選、名稱沒改過、沒有焦點），就把這個工作區關掉，checkout 和分支都不動。
其他工作區（包括從沒掛過 worktree 的主 checkout 工作區）完全不動。
它每 10 分鐘掃一次，智慧體結束後約一分鐘也會掃，`reap-now` 動作則立刻掃。
每一次關閉、移除、略過和釘選，都是 plugin 日誌（`herdr plugin log list --plugin wayne930242.straw-boss-reaper`）裡的一行。

釘選的工作區永遠不會被清理，它的 checkout 也不會被移除；釘選只做這件事。關掉釘選的工作區，它就關掉了。
工作區一改名就會自動釘選；`pin` 動作會切換它所在工作區的釘選，取消釘選不會動到名稱。
釘選是工作區的 token `$pin`，內容是 Nerd Font 的圖釘字形，要加進 Space 的列設定才看得到。
需要 Herdr 0.9.3 以上、git 和 node 18 以上。
它只支援 macOS 和 Linux：在 Windows 上，Herdr 不會回報 pane 的 shell 底下在跑什麼，reaper 分不出閒置的 pane 和正在跑 build 或編輯器的 pane。

```bash
herdr plugin install wayne930242/pi-straw-boss/herdr-reaper
```

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "wayne930242.straw-boss-reaper.pin"
description = "pin or unpin the workspace"

[ui.sidebar.spaces]
rows = [["state_icon", "workspace", { token = "$pin" }], ["branch", "git_status"]]
```

也可以用 `herdr plugin link /path/to/pi-straw-boss/herdr-reaper` 連結原始碼，用 `herdr plugin unlink wayne930242.straw-boss-reaper` 移除。
plugin 一安裝或連結就開始清理，沒有試跑，也不會先問：第一次掃描會把 linked-worktree 工作區裡所有沒有智慧體、shell 閒置的 pane 都當成智慧體已結束，大約在第一個 hook 執行後一分半鐘。
請先執行 `bash herdr-reaper/run.sh reaper.mjs dry-run` 看它會做什麼，並釘選想保留的工作區（plugin 連結後 `pin` 動作才能用；也可以在連結之前，先在 plugin 的設定目錄放一個帶 `only_under` 的 `config.json`）。
[運作方式](docs/how-it-works.md#worktree-reaper)（英文）有規則和限制。

## 行程清理

每個 pi 都會載入一個小擴充，在環境變數裡留下標記，所以 worker 的 bash 啟動的東西，就算被 `timeout` 或 `setsid` 搬到自己的行程群組，仍帶著 worker 的 id。
pi-herdr-agents 的 worker 會向 sb 伺服器登記；worker 結束或它的 pane 關掉時，伺服器收掉它留下的行程（先 SIGTERM，10 秒後 SIGKILL，每一步都用 pid 和啟動時間再確認），並記一行 `procs-reaped`。
`worktree_remove` 和 bash 的 `git worktree remove`，在還有行程以該 checkout 為工作目錄時會被擋下，並列出每個行程的 pid、程式名稱、CPU 和存活時間，以及收掉它們的指令：`node dist/server/cli.mjs procs reap --checkout <path>`。
`cli.mjs procs` 列出伺服器認得的 worker。
重型指令的 slot、Linux cgroup 和失控行程的看門狗留待下一版。
規則與限制見[運作方式](docs/how-it-works.md#process-hygiene-and-slots)。

## 延伸閱讀

[運作方式](docs/how-it-works.md)（英文）說明角色、塔台、儀表板、瀏覽器畫面、這個擴充套件會寫入什麼，以及 Claude Code 或 Codex 的 session 怎麼加入網。

## 授權

MIT。瀏覽器畫面的圖示來自 [game-icons.net](https://game-icons.net)（Lorc 與 Delapouite，[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)）；詳見 [gui/ICONS.md](gui/ICONS.md)。
