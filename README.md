<p align="center"><img src="docs/assets/line-agent-cover-v3.png" alt="LINE Agent MCP v3.0.0 — Text + images. Context, faster." width="100%"></p>

# LINE Agent MCP

**整理 LINE 上下文，連圖片一起看；快速讀取，把時間留給判斷與回覆。**

指定聊天室與日期，讓 AI 一起整理文字和可用的快取圖片，掌握進度、附件線索與待辦。圖片由 MCP 提供給支援影像的模型判讀；縮圖、原圖和缺失狀態都有標示。

[繁體中文](README.md) · [English](docs/README.en.md) · [日本語](docs/README.ja.md) · [ภาษาไทย](docs/README.th.md) · [Bahasa Indonesia](docs/README.id.md)

[v3.3.9 更新說明](docs/releases/README.md) · [安裝指南](docs/quickstart-windows.md) · [工具與限制](docs/windows-extensions.md)

**v3.3.9 — Keep 筆記開窗與版本相容修正：** 支援使用內建捷徑自動開啟 Keep 筆記獨立視窗，並適配 Windows CUA Driver 0.46.1 及已核對的 LINE 26.6.0.4004 版本。[更新說明](docs/releases/v3.3.9.zh-TW.md)

**v3.3.8 — 聊天室選取與引用核對修正：** 列出確切名稱候選，以聊天室／帳號參照開啟唯一既有直聊；減少草稿核對的重複快照，修正獨立視窗引用確認，補上收回的實測操作指引。[更新說明](docs/releases/v3.3.8.zh-TW.md)

**v3.3.5 — 混合搜尋 OCR 修正：** 分類各自裁切、補足標題範圍與 OCR 白邊，避免唯一聊天室因分類標頭漏讀被拒絕；完整名稱與身分核對不變。[更新說明](docs/releases/v3.3.5.zh-TW.md)

**v3.3.4 — 單筆個人搜尋修正：** 搜尋結果 OCR 漏掉較淡的分類／筆數時，從同一截圖另外裁切辨識；完整視窗標題和本機身分核對仍須通過。[更新說明](docs/releases/v3.3.4.zh-TW.md)

**v3.3.3 — 最近群組清單修正：** 最近聊天室不再把群組在通用 `_chat` 索引的資料列誤當成個人聊天室衝突；真正的身分衝突仍會排除。[更新說明](docs/releases/v3.3.3.zh-TW.md)

**v3.3.2 — 搜尋與主視窗核對：** 逐字辨識分類頁籤、將聊天室列與訊息歷史分開，嚴格限制個人聊天室單筆導覽備援；主視窗及最小化恢復都依完整結構重新核對。曖昧時拒絕。[更新說明](docs/releases/v3.3.2.zh-TW.md)

**v3.3.1 — 群組搜尋修復：** 支援被截斷的群組搜尋名稱；先開啟候選，再核對完整視窗標題與聊天室／帳號。另修正身分查詢漏回傳已核對帳號的問題。[更新說明](docs/releases/v3.3.1.zh-TW.md)

**v3.3.0 — 收件人綁定與原訊息轉發：** 新增最近聊天室清單、收件人預檢及轉發核對。既有直聊不再單純被未聊天的同名好友擋住，而是綁定聊天室／帳號，再以實際畫面核對；名稱唯一的對象保留原本快速流程。結果不確定仍不自動重送。[更新與實測界線](docs/releases/v3.3.0.zh-TW.md)

**v3.2.0 — 普通文字傳送與本機回執：** 指定聊天室與本人身分核對後，單次操作最多 30 秒，並查核新產生的本人本機訊息。`RECORDED_LOCAL` 不代表對方收到或已讀；結果不確定時以相同 `idempotencyKey` 唯讀重查，不自動重送。指定日期的讀取／搜尋／匯出／核對共用本機讀取器；未指定日期仍讀介面已載入歷史。Windows 擴充清單顯示 26 個工具，另有 5 個隱藏但仍可呼叫的舊別名。[詳見更新說明](docs/releases/v3.2.0.zh-TW.md)

**v3.1.0 — 本機唯讀 CLI：** 新增 `line-cli`，可查能力與本機狀態，並依指定聊天室及日期讀取、匯出 JSON／TXT／CSV。每次只處理一頁，日期最多 31 天；不操作 GUI，也不發送訊息。 [CLI](docs/CLI.md) · [v3.1.0](docs/releases/v3.1.0.zh-TW.md)


**v3.0.1 大型資料庫修復：** 修正資料庫超過 256 MiB 就無法讀取的問題，改用串流快照，預設支援 2 GiB DB，並保留 WAL 與來源穩定性檢查。不需要刪除聊天紀錄。[更新說明](docs/releases/v3.0.1.zh-TW.md) · [升級](docs/MIGRATING.md#upgrading-to-v301)

這是 **LINE Agent MCP**，由 [bensonmaxai](https://github.com/bensonmaxai/line-desktop-mcp) 維護的 Windows 社群版，建立在 [dtwang/line-desktop-mcp](https://github.com/dtwang/line-desktop-mcp) 之上。透過本機 MCP 連接已登入的 LINE Desktop，日常以 Codex 使用，也能搭配其他支援本機 MCP 的客戶端。本專案與 LINE 官方無關。

Windows 啟用 `LINE_MCP_EXTENSIONS=1` 後列出 **33 個目前使用的工具**，另有 **5 個可呼叫但不列出的舊別名**。未啟用時列出 **5 個工具**。macOS 也列出五個預設工具，但讀取／發送功能不可用。

**v3.0.0 安全更新：** Windows 所有指定聊天室的 GUI 操作（含預設五工具）都需要 CUA 與本機讀取器。先用不讀訊息的本機中繼資料核對唯一聊天室，再驗證已開啟的 LINE 標頭；不再自動點搜尋第一筆。macOS 讀取／發送目前會在自動化前拒絕。引用截圖限定指定聊天室、APNG 僅輸出首幀；GUI 歷史複製在沒有其他寫入者介入時恢復先前剪貼簿。[更新說明](docs/releases/v3.0.0.zh-TW.md) · [升級與回退](docs/MIGRATING.md#upgrading-to-v300)

## 可以做什麼

| 工作 | 能力與界線 |
| --- | --- |
| 追蹤進度 | 從指定群組或個人對話的本機 DB/WAL 讀取文字與附件資訊；一次最多 31 天，可分頁追查 |
| 看圖理解上下文 | 需要時才解碼快取圖片；回傳可供模型讀取的圖片區塊，縮圖與原圖、缺失與延後處理都有標示 |
| 減少等待 | 已驗證的工作階段使用短期定位資訊加速；每次仍重新擷取並驗證資料 |
| 準備可靠回覆 | 引用回覆須核對原文、發話者、時間與目前畫面，使用一次性的來源確認 token |
| 看投票進度 | 讀取已開啟、且已與指定群組核對的投票面板；未觀察到的欄位保留未知 |
| 版本變動時停止誤讀 | 讀取前檢查 LINE 執行檔版本與雜湊；未驗證版本回報 `LINE_BUILD_UNVERIFIED` |
| 讓工作留在同一個對話 | 由 agent 查資料、整理與操作 LINE；普通文字草稿在 Codex 確認後送出，不必另開工作台 |

## 一段對話，完成整個流程

![LINE 工作流程：讀取對話、整理進度、確認草稿、送出、讀回核對](docs/assets/workflow-zh-TW.svg)

例如：「看一下 LINE 的『範例客戶』，整理目前進度與待回覆事項。」Agent 先讀指定範圍，必要時使用你另行提供或授權的文件與連接器補充資料，再在 Codex 顯示完整草稿。你確認收件人與內容後，才進行送出與讀回核對。

`send_message_auto` 可送出已核准的普通文字。`send_message_manual` 僅在你要求於 LINE 檢閱時暫存草稿。真正的藍色提及、引用選取、投票建立等視覺步驟由 agent 操作；工具計畫本身不代表已送出或已發布。

## 安裝與升級

```powershell
git clone --branch v3.3.5 --depth 1 https://github.com/bensonmaxai/line-desktop-mcp.git
cd line-desktop-mcp
npm ci --ignore-scripts
```

依使用功能準備不同依賴：

| 功能 | 需要的執行環境 |
| --- | --- |
| 啟動／能力清單 | Node.js 24 LTS 或更新版本；本版測試使用 24.19.0 |
| 本機對話讀取 | Windows x64、已登入且版本在允許清單內的 LINE、Python x64、`cryptography`、Pillow、固定雜湊的 SQLite3MC DLL |
| 圖片預覽 | 使用上述讀取環境，由 Pillow 解碼 |
| 介面操作／傳送 | 上述本機讀取環境與相容的 CUA Driver；依路徑使用 AutoHotkey v2 與 Windows 本機 OCR |

本機讀取必須明確設定 `LINE_MCP_PYTHON` 與 `LINE_MCP_SQLITE3MC_DLL`；介面操作使用 `LINE_MCP_CUA_DRIVER`。伺服器啟動不會自行安裝依賴、讀取聊天或修改全域設定。完整步驟、固定 DLL 來源與 MCP 設定見[安裝指南](docs/quickstart-windows.md)。

**v1.2.0／v2.0.0 使用者可沿同一個專案升級。** MCP 名稱與五個預設工具名稱保留；Windows GUI 操作需要本機讀取器與 CUA，`open_line_chat` 會核對精確聊天室，必要時開啟並核驗有標題的視窗。macOS 讀取／發送不可用。保留舊目錄與設定、在新目錄安裝後切換啟動器，並重新連線、刷新工具 schema。LINE 帳號與聊天資料不需搬移。[完整升級與回退指南](docs/MIGRATING.md)

本專案透過 GitHub 原始碼 tag 與 `.tgz` 發布，未發布至 npm registry，也未提供 MCPB。舊套件 `line-desktop-mcp@latest` 不會安裝本專案。

## 速度與驗證

![本機核心讀取實測比較](docs/assets/performance.svg)

以下是 v2.0.0 時期同一台維護者電腦的量測，並非 v3.0.0 新基準。文字歷史的冷讀核心由 **17.866 秒降至 4.661 秒**；重啟驗收後，持續 MCP 連線的暖讀約 **0.732–0.803 秒**。圖片解碼、Codex 路由、模型處理及介面操作還會增加時間，這些數字不是所有電腦的速度保證。

v2.0.0 時期的兩次實際 LINE 重啟後均成功讀取指定範圍；實際圖片已通過 MCP 傳輸、獨立解碼與雜湊核對。v3.2.0 已進行普通文字與本機紀錄的實機檢查；提及、引用、投票等豐富功能則是引導式視覺操作，並非自主 MCP 工具執行。各項實測不能互相替代，也不代表對方收到或已讀。[v3.2.0 驗證界線](docs/releases/v3.2.0.zh-TW.md)

```powershell
npm test
npm run test:python
```

測試使用合成訊息與模擬介面，不會讀取真實聊天室或送出訊息。Python 測試需要先設定指定執行環境。

## 使用界線

- 本機快取不等於完整伺服器歷史；讀取範圍、快照時間、缺失媒體與分頁都會明示。
- 日期篩選與投票計畫目前固定採 **Asia/Taipei（UTC+08:00）**。
- 本機讀取需要對已登入 LINE 程序進行受限的唯讀記憶體存取，以取得該工作階段的解碼資料；未知版本或存取遭拒時停止。
- 目前實測 Windows LINE **26.4.2.3957，繁體中文介面**；五語文件不代表五種 LINE UI 語言都已通過實機驗證。
- 支援 PNG/JPEG、GIF/WebP/APNG 首幀及小型 PCM WAV 區塊；其他已辨識的音訊、影片與檔案以資訊回傳，沒有通用播放、轉錄或檔案擷取功能。
- 文字存在不等於對方收到或已讀；提及通知需另外核對真實藍色 token。傳送結果不確定時不自動重送。
- 解碼與 OCR 在本機執行；回傳的工具內容仍由你的 AI 客戶端及模型依其設定處理。

## 語言、貢獻與授權

繁中、日文、泰文與印尼文對應這次官方資料涵蓋的市場，英文作為共通版本。[語言選擇與官方來源](docs/LANGUAGES.md)

問題請回報至 [Issues](https://github.com/bensonmaxai/line-desktop-mcp/issues)，附版本、工具名稱與去識別化錯誤；請勿張貼真實聊天、帳號或解碼資料。採 [MIT License](LICENSE.md)，保留原作者 Geoffrey Wang 的署名。[第三方依賴與素材](docs/THIRD_PARTY.md)

封面為 AI 生成的概念插圖，流程與速度圖為程式繪製，均非 LINE 官方素材或真實聊天截圖。

本版僅提供本機 stdio 連線；不提供 HTTP／REST 服務，也不會自動載入啟動目錄的 `.env`。請透過 MCP 客戶端明確設定環境變數。
