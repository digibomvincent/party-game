# 朋友大頭賽跑（手機當搖桿）

電腦／電視開主畫面，朋友用手機掃 QR Code 加入，用手機大按鈕連打讓自己的色塊往終點跑。

- 人數不設上限，**每 4 人一組**輪流跑，全部組別跑完後依「抵達時間」結算總成績。
- 後端只轉送訊息；**所有遊戲邏輯都在 `public/host.js`**。

## 專案結構

```
party-race/
├── server.js               # Express + Socket.IO：房間管理、訊息轉送、印出區網網址
├── package.json
└── public/
    ├── host.html / host.js            # 主畫面（Phaser 3 畫跑道；遊戲邏輯都在這）
    ├── controller.html / controller.js # 手機控制器
    ├── characters.json                # 角色資料（目前 4 個色塊）
    └── img/                           # 之後放角色圖片
```

## 啟動

需要 Node.js 18 以上。

```bash
npm install
npm start
```

終端機會印出主畫面網址，例如 `http://192.168.1.23:3000/host.html`。

### 手機連線測試
1. 電腦與手機連**同一個 Wi-Fi**。
2. 電腦瀏覽器開終端機印出的網址（用區網 IP 那個），畫面會顯示房號與 QR Code。
3. 手機掃 QR Code → 輸入暱稱 → 加入。
4. 主畫面按「開始」。

常見問題：
- **手機打不開**：Windows 防火牆第一次會問 Node.js，請選「允許私人網路」。
- **QR Code 的 IP 不對**（電腦有多張網卡）：用 `$env:LAN_IP="192.168.x.x"; npm start` 手動指定。
- **Wake Lock、震動**：Wake Lock 只在 https 下有效（部署到 Render 就有）；iPhone 不支援震動。

## 遊戲流程

`lobby → countdown → racing → heatResult →（下一組 countdown …）→ result`

1. 大廳：顯示房號、QR Code、已加入玩家，至少 1 人才能按「開始」。
2. 依加入順序每 4 人一組，每組先 3、2、1、GO 倒數（手機按鈕鎖住）。
3. 每按一下前進 `STEP_DISTANCE`。全員到終點，或第一名到後 10 秒，該組結束。
4. 顯示該組結果，按「開始下一組」。沒輪到的手機會顯示等待。
5. 最後一組完成後顯示總成績：先依抵達時間排序，沒跑完的排最後（依位置）。
6. 「再來一場」：重新分組、從第 1 組開始倒數。

細節：
- 遊戲開始後才加入的人，這場先等待，下一場才會被分組。
- 遊戲中斷線的人保留位置、標示離線，重整後用同一個 playerId 會接回來。
- 大廳中斷線的人會直接從名單移除。
- **host 重整頁面或斷線＝房間作廢**，需重新建立。

## 遊戲數值（`public/host.js` 最上方）

| 常數 | 意義 |
|---|---|
| `TRACK_LENGTH` | 跑道長度 |
| `STEP_DISTANCE` | 每按一下前進距離 |
| `PLAYERS_PER_HEAT` | 每組人數 |
| `COUNTDOWN_SECONDS` | 倒數秒數 |
| `FINISH_TIMEOUT_MS` | 第一名到後等待多久結束該組 |
| `HEAT_MAX_MS` | 保險：單組最長時間 |

## 事件列表

| 事件 | 方向 | 內容 |
|---|---|---|
| `host:create` | host → server | 建立房間；callback 回傳 `{ room, controllerUrl }` |
| `player:join` | 手機 → server → host | `{ room, playerId, name }`（server 轉給 host 時為 `{ playerId, name }`）；手機有 callback `{ ok, error }` |
| `game:state` | host → 所有手機 | `{ phase, heat, totalHeats }`，phase 為 `lobby / countdown / racing / heatResult / result` |
| `tap` | 手機 → host | 按鍵（server 補上 `playerId`） |
| `player:status` | host → 單一手機 | `{ playerId, status }`；status 含 `role / heat / color / finished / heatRank / overallRank / finishTime` |
| `player:left` | server → host | `{ playerId }`，玩家斷線 |
| `room:closed` | server → 手機 | host 離開，房間關閉 |

> `heatResult`（每組結果）是在你要求的四個階段之外多加的一個，用來在組與組之間停一下。

## 部署到 Render
- Build Command：`npm install`；Start Command：`npm start`
- 程式已監聽 `process.env.PORT`，並會自動使用 `RENDER_EXTERNAL_URL` 產生 QR Code 網址。
