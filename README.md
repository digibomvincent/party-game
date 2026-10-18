# Party Game（手機當搖桿的派對遊戲大廳）

電腦／電視開主畫面，朋友用手機掃 QR Code 加入，先選角色與衣服顏色，進**遊戲大廳**（左欄選遊戲、右欄是已加入的玩家），主持人選好遊戲按「開始」。

目前的遊戲：
- 🏃 **跑步**：用手機**左右兩顆按鈕交替連按**讓自己的角色往終點跑。
- ⚽ **足球**（測試中）：俯視球場，用虛擬搖桿跑位推球；紅藍分隊（最多 5v5）、進球計分、3 分鐘比賽、平手金球加時、結算。手機左邊是搖桿，右邊兩顆按鈕：**頭槌**（按住蓄力、放開後脖子伸長把球撞出去，蓄越久打越遠）和**衝刺**（有冷卻）。道具之後再做，規劃見 [`docs/soccer-plan.md`](docs/soccer-plan.md)。

- **每組最多 5 人**，人數不能整除時平均分組（10 人 → 5+5、11 人 → 4+4+3），全部組別跑完後依「抵達時間」結算總成績。
- 角色可以重複，**衣服顏色同一場不能重複**（共 12 色，所以最多 12 人能上場）。
- 後端只轉送訊息；**遊戲邏輯都在主畫面（host）端**：大廳在 `public/host.js`，每個遊戲一個檔案放在 `public/games/`。

## 專案結構

```
party-race/
├── server.js               # Express + Socket.IO：房間管理、訊息轉送、印出區網網址
├── package.json
└── public/
    ├── host.html / host.js            # 主畫面：遊戲大廳（玩家、選角色與顏色、選遊戲、階段、與手機溝通），提供 Hub 給各遊戲用
    ├── games/
    │   ├── race.js                    # 「跑步」遊戲：規則、分組、名次、Phaser 跑道場景
    │   └── soccer.js                  # 「足球」遊戲（開發中）：球場、物理、搖桿輸入
    ├── char-render.js                 # 各遊戲共用：角色的大頭貼圖與跑步身體動畫（程式即時畫）
    ├── controller.html / controller.js # 手機控制器
    ├── characters.json                # 角色清單（4 個，每個有 art 大圖與 head 頭圖）與可選的衣服顏色（12 色）
    ├── characters.js                  # 主畫面與手機共用：預設角色臉的畫法、載入圖檔
    └── img/                           # 角色圖：NN.jpg（或 .png）是選角時的大圖，NN_head.png 是頭（透明背景 PNG；沒填的角色用預設臉）
```

## 啟動

需要 Node.js 18 以上。

```bash
npm install
npm start
```

終端機會印出主畫面網址，例如 `http://192.168.1.23:3000/host.html`。

### 假玩家測試（不用真的手機）
```bash
npm start                              # 另一個終端機：開伺服器、在瀏覽器開主畫面，記下房號
npm run fake -- <房號> 10              # 10 個假玩家加入，依遊戲自動玩（跑步連打；足球搖桿 + 頭槌 + 衝刺）
npm run fake -- <房號> 10 --chaos      # 混亂模式：隨機斷線，1～3 秒後用同一個身分重連
```

### 手機連線測試
1. 電腦與手機連**同一個 Wi-Fi**。
2. 電腦瀏覽器開終端機印出的網址（用區網 IP 那個），畫面會顯示房號與 QR Code。
3. 手機掃 QR Code → 輸入暱稱 → 加入 → 選角色 → 選衣服顏色。
4. 主畫面按「開始」（沒選好的人這場不會上場）。

常見問題：
- **手機打不開**：Windows 防火牆第一次會問 Node.js，請選「允許私人網路」。
- **QR Code 的 IP 不對**（電腦有多張網卡）：用 `$env:LAN_IP="192.168.x.x"; npm start` 手動指定。
- **Wake Lock、震動**：Wake Lock 只在 https 下有效（部署到 Render 就有）；iPhone 不支援震動。

## 新增 / 更換角色圖
1. 大圖 `xx.png`、頭 `xx_head.png`（透明背景）放進 `public/img/`。
2. 在 `public/characters.json` 的 `characters` 裡填上 `"art": "img/xx.png"`、`"head": "img/xx_head.png"`。
3. 選角畫面：下排小方格是 `head`，點選後上方顯示 `art`；比賽時 `head` 會接在跑步身體上。
4. 大圖檔案越大，手機載入越慢，建議壓到 1MB 以內。

## 遊戲流程

大廳（`lobby`）選遊戲 →（跑步）→ 結算後可「再來一場」或「回遊戲大廳」。

新增遊戲：
1. `public/host.js` 的 `GAME_LIST` 加一項（`enabled: false` 會顯示「即將推出」）。
2. 新增 `public/games/xxx.js`，結尾登記 `Hub.games.xxx = { start, stop, onInput, ... }`（介面說明在 `host.js` 最上方，範例是 `games/race.js`），並在 `host.html` 加上 `<script>`。
3. 大廳負責玩家、角色、顏色與廣播；遊戲只管自己的規則與畫面，自己的玩家狀態放在 `p.xxx`（跑步用 `p.race`）。

跑步的階段：`lobby → countdown → racing → heatResult →（下一組 countdown …）→ result`

1. 大廳：顯示房號、QR Code、已加入玩家，至少 1 人才能按「開始」。
2. 依加入順序平均分組（每組最多 5 人），每組先 3、2、1、GO 倒數（手機按鈕鎖住）。
3. **左右交替**按才會前進，每下前進 `STEP_DISTANCE`；**左右同時按會跌倒**（`FALL_MS` 內按鍵無效）；**連按同一邊會原地跳一下**、這下不前進，之後 `SLOW_MS` 內每步只前進 `SLOW_FACTOR`。全員到終點，或第一名到後 10 秒，該組結束。
4. 顯示該組結果，按「開始下一組」。沒輪到的手機會顯示等待。
5. 最後一組完成後顯示總成績：先依抵達時間排序，沒跑完的排最後（依位置）。
6. 「再來一場」：重新分組、從第 1 組開始倒數。

細節：
- 遊戲開始後才加入的人，這場先等待，下一場才會被分組。
- 遊戲中斷線的人保留位置、標示離線，重整後用同一個 playerId 會接回來。
- 大廳中斷線的人會直接從名單移除。
- **host 重整頁面或斷線＝房間作廢**，需重新建立。

## 跑步的遊戲數值（`public/games/race.js` 最上方）

| 常數 | 意義 |
|---|---|
| `TRACK_LENGTH` | 跑道長度 |
| `STEP_DISTANCE` | 每按一下前進距離 |
| `PLAYERS_PER_HEAT` | 每組最多幾人（會平均分） |
| `FALL_MS` | 左右同時按 → 跌倒多久 |
| `SLOW_MS` / `SLOW_FACTOR` | 連按同一邊 → 變慢多久／變慢後每步的比例 |
| `COUNTDOWN_SECONDS` | 倒數秒數 |
| `FINISH_TIMEOUT_MS` | 第一名到後等待多久結束該組 |
| `HEAT_MAX_MS` | 保險：單組最長時間 |

## 事件列表

| 事件 | 方向 | 內容 |
|---|---|---|
| `host:create` | host → server | 建立房間；callback 回傳 `{ room, controllerUrl }` |
| `player:join` | 手機 → server → host | `{ room, playerId, name }`（server 轉給 host 時為 `{ playerId, name }`）；手機有 callback `{ ok, error }` |
| `game:state` | host → 所有手機 | `{ phase, heat, totalHeats, taken }`（`taken` = 已被選走的顏色），phase 為 `lobby / countdown / racing / heatResult / result` |
| `tap` | 手機 → host | `{ side }`，side 為 `L / R / both`（server 補上 `playerId`） |
| `input` | 手機 → server → host | `{ mx, my, dash, neck }`，足球的持續輸入（搖桿方向 -1~1；衝刺、頭槌是否按住）；有東西按住時每 150ms 重送一次整組，server 補上 `playerId` 並限制範圍 |
| `player:pick` | 手機 → server → host | `{ charId, color }`；host 檢查顏色有沒有被選走，結果用 `player:status` 回 |
| `player:status` | host → 單一手機 | `{ playerId, status }`；status 含 `role / heat / picked / charName / color / finished / heatRank / overallRank / finishTime` |
| `player:left` | server → host | `{ playerId }`，玩家斷線 |
| `room:closed` | server → 手機 | host 離開，房間關閉 |

> `heatResult`（每組結果）是在你要求的四個階段之外多加的一個，用來在組與組之間停一下。

## 部署到 Render
- Build Command：`npm install`；Start Command：`npm start`
- 程式已監聽 `process.env.PORT`，並會自動使用 `RENDER_EXTERNAL_URL` 產生 QR Code 網址。

## 足球的規則與數值（`public/games/soccer.js` 最上方）

| 常數 | 意義 |
|---|---|
| `MAX_PLAYERS` | 最多上場人數（10 人 = 5v5），超過的人這場先等 |
| `MATCH_SECONDS` | 一場比賽幾秒（預設 180） |
| `OVERTIME_SECONDS` | 平手時金球加時最久幾秒；加時仍沒進球就算平手 |
| `COUNTDOWN_SECONDS` / `GOAL_PAUSE_MS` | 開球倒數秒數／進球後慶祝多久（慶祝與倒數時比賽時間暫停） |
| `MAX_SPEED` / `ACCEL` | 角色最高速度／加減速的靈敏度 |
| `CHARGE_SECONDS` / `CHARGE_MOVE` | 頭槌蓄滿要多久／蓄力時移動速度的比例 |
| `NECK_MIN` / `NECK_MAX` | 脖子最短／最長伸出的距離 |
| `KICK_MIN` / `KICK_MAX` | 頭槌把球打出去的速度（輕點／蓄滿） |
| `DASH_SPEED` / `DASH_SECONDS` / `DASH_COOLDOWN` | 衝刺速度、持續時間、冷卻 |
| `BALL_DRAG` / `WALL_BOUNCE` / `HIT_BOUNCE` | 球的滾動阻力／撞牆彈性／被角色撞時的彈性 |

規則：紅隊守左邊球門、攻右邊球門，藍隊相反；球整顆越過球門線才算進球。最後碰到球的是對方隊員則算**烏龍球**（得分給進攻隊，但不記個人進球）。

### 斷線與重連（足球）
- 手機斷線 / 沒訊號 / 切分頁：角色變成半透明的「幽靈」，不會動也不會擋路，球可以穿過去；手機用同一個身分重連（重新整理頁面或網路恢復會自動重連）就會回到原本的角色與隊伍。
- 搖桿或按鈕超過 0.6 秒沒收到更新，一律當作放開；蓄力中斷線會取消，不會突然撞出去。
- **整隊**的人都離線時，畫面上方會提示；`FORFEIT_GRACE_MS`（預設 15 秒）內沒人回來，該隊判棄權、另一隊獲勝；兩隊都沒人就自動回大廳。
- 伺服器會限制每個連線每秒最多送幾次輸入（`server.js` 的 `RATE_LIMIT`），避免有人（或壞掉的網頁）狂送訊息拖垮主畫面。
- **主畫面（host）重新整理或斷線 = 房間作廢**，這一點不變；開著主畫面的電腦不要休眠。
