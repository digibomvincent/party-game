// ============================================================
// host.js － 主畫面的「遊戲大廳」：
//   玩家名單、選角色與顏色、選遊戲、階段切換、與手機的溝通
// 各遊戲的規則與畫面放在 public/games/*.js（目前只有 race.js），
// 遊戲透過 Hub 取用大廳的功能，並把自己登記在 Hub.games[遊戲id]。
//
// 遊戲要實作的介面（見 games/race.js）：
//   start()                  按「開始」時呼叫，由遊戲自己決定誰上場、怎麼進行
//   stop()                   回大廳時呼叫，清掉計時器、面板、畫面
//   onInput(playerId, data)  收到手機的輸入：tap 事件 { side }（跑步）或 input 事件 { mx, my, dash, neck }（足球）
//   onPlayerLeft(player)     有人斷線（大廳之外的階段）
//   onPlayerJoin(player)     有人加入或重連（遊戲進行中）
//   onPhase(phase)           階段切換時更新遊戲自己的面板
//   statusOf(player)         傳給某位玩家手機的遊戲狀態（和通用狀態合併）
//   stateExtra()             廣播給所有手機的 game:state 附加欄位
//   lobbyInfo(readyCount)    大廳左欄下方的提示文字
// 階段 phase：lobby（遊戲大廳）→ 各遊戲自己的階段 → 回 lobby
// ============================================================

const socket = io();
const $ = (id) => document.getElementById(id);

// 畫面排版（Phaser 畫布大小 1280x720）
const CANVAS_W = 1280, CANVAS_H = 720;

// ---------- 遊戲清單（大廳左欄）----------
// 要新增遊戲：這裡加一項（顯示用的資料），再寫 games/xxx.js 並登記 Hub.games.xxx。
// enabled:false 的會顯示「即將推出」，不能選。
const GAME_LIST = [
  { id: 'race',   icon: '🏃', name: '跑步', desc: '左右交替連按，衝向終點！', enabled: true },
  { id: 'soccer', icon: '⚽', name: '足球', desc: '搖桿跑位，用大頭把球頂進球門', enabled: true,  badge: '測試中' },
  { id: 'spinner', icon: '🌀', name: '陀螺大戰', desc: '傾斜手機操控陀螺，把別人撞出平台', enabled: false, badge: '規劃中' },
];
let selectedGame = 'race';   // 大廳目前選的遊戲

// ---------- 大廳提供給各遊戲的功能 ----------
const Hub = {
  socket, $,
  players: new Map(),        // playerId -> { id, name, online, charId, color, photo, race(跑步的狀態) ... }
  characters: [],            // 角色資料（characters.json）
  colors: [],                // 可選的衣服顏色（hex 字串），每個顏色同一場只能一個人選
  games: {},                 // 遊戲id -> 遊戲實作（各 games/*.js 登記）
  currentGame: null,         // 正在玩的遊戲實作（在大廳時是 null）
  currentGameId: null,
  phase: 'lobby',
  game: null,                // Phaser.Game（下面建立）
  escapeHtml, setPhase, sendStatus, sendAllStatus, broadcastState, backToLobby, onlinePlayers,
};

// Phaser 畫布：場景由各遊戲自己登記、啟動（games/race.js 會 game.scene.add）
Hub.game = new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', width: CANVAS_W, height: CANVAS_H, backgroundColor: '#101820',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
});
CharRender.init(Hub.game);

let roomCode = null;

function onlinePlayers() { return [...Hub.players.values()].filter((p) => p.online); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// 對外溝通：廣播階段、傳個人狀態
// ============================================================
// 廣播目前階段 + 已被選走的顏色給所有手機（遊戲可用 stateExtra() 附加欄位，例如跑步的第幾組）
function takenColors() { return [...Hub.players.values()].map((p) => p.color).filter(Boolean); }
function broadcastState() {
  const g = Hub.currentGame;
  socket.emit('game:state', {
    phase: Hub.phase, game: Hub.currentGameId, heat: 0, totalHeats: 0,
    ...(g && g.stateExtra ? g.stateExtra() : {}),
    taken: takenColors(),
  });
}

// 切換階段：更新畫面面板 + 廣播給所有手機
function setPhase(next) {
  Hub.phase = next;
  broadcastState();
  $('lobby').classList.toggle('hidden', next !== 'lobby');
  $('homeBtn').classList.toggle('hidden', next === 'lobby');   // 遊戲中可隨時回大廳
  if (Hub.currentGame && Hub.currentGame.onPhase) Hub.currentGame.onPhase(next);
  sendAllStatus();
}

// 組出要傳給某位玩家手機的個人狀態：通用部分（角色、顏色）+ 目前遊戲的部分
function statusOf(p) {
  const g = Hub.currentGame;
  return {
    picked: !!(p.charId && p.color),
    charName: (Hub.characters.find((c) => c.id === p.charId) || {}).name || '',
    color: p.color || '#888888',
    ...(g && g.statusOf ? g.statusOf(p) : {}),
  };
}
function sendStatus(p) { socket.emit('player:status', { playerId: p.id, status: statusOf(p) }); }
function sendAllStatus() { Hub.players.forEach((p) => p.online && sendStatus(p)); }

// ============================================================
// 大廳
// ============================================================
function renderGames() {
  $('gameList').innerHTML = GAME_LIST.map((g) =>
    `<div class="game-card${g.id === selectedGame ? ' sel' : ''}${g.enabled ? '' : ' off'}" data-id="${g.id}">` +
    `<div class="icon">${g.icon}</div><div><div class="name">${g.name}</div><div class="desc">${g.desc}</div></div>` +
    (g.badge || !g.enabled ? `<span class="badge">${g.badge || '未開放'}</span>` : '') + `</div>`).join('');
}
$('gameList').onclick = (e) => {
  const card = e.target.closest('.game-card');
  const g = card && GAME_LIST.find((x) => x.id === card.dataset.id);
  if (!g || !g.enabled) return;
  selectedGame = g.id;
  renderLobby();
};

// 大廳玩家頭像：有 head 圖就用圖，沒有就用預設臉（轉成圖片網址並快取）
const avatarCache = {};
function avatarUrl(c, i) {
  if (c.head) return c.head;
  if (!avatarCache[c.id]) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 72;
    CharArt.drawFace(cv.getContext('2d'), 72, i);
    avatarCache[c.id] = cv.toDataURL();
  }
  return avatarCache[c.id];
}

function renderLobby() {
  renderGames();
  const list = onlinePlayers();
  const ready = list.filter((p) => p.color);
  $('count').textContent = list.length;
  $('playerList').innerHTML = list.length ? list.map((p) => {
    const ci = Hub.characters.findIndex((x) => x.id === p.charId), c = Hub.characters[ci];
    const avatar = c ? `<img class="av" src="${avatarUrl(c, ci)}" alt="">` : `<span class="av"></span>`;
    return p.color
      ? `<li style="--c:${p.color}">${avatar}<span>${escapeHtml(p.name)}${c ? `<br><small>${c.name}</small>` : ''}</span></li>`
      : `<li style="opacity:.6"><span class="av"></span><span>${escapeHtml(p.name)}<br><small>選角色中…</small></span></li>`;
  }).join('') : '<li class="empty">用手機掃 QR Code 加入</li>';
  $('startBtn').disabled = ready.length < 1;
  const g = Hub.games[selectedGame];
  let text = g && g.lobbyInfo ? g.lobbyInfo(ready.length) : '';
  if (ready.length < list.length) text += `；還有 ${list.length - ready.length} 人沒選好，不會上場`;
  $('info').textContent = text;
}

// ============================================================
// 開始遊戲 / 回大廳
// ============================================================
function startSelectedGame() {
  const g = Hub.games[selectedGame];
  if (!g || onlinePlayers().every((p) => !p.color)) return;
  Hub.currentGame = g;
  Hub.currentGameId = selectedGame;
  g.start();
}

// 回遊戲大廳：玩家名單、角色與顏色都保留，遊戲自己的狀態由 stop() 清掉
function backToLobby() {
  if (Hub.currentGame && Hub.currentGame.stop) Hub.currentGame.stop();
  Hub.currentGame = null; Hub.currentGameId = null;
  for (const [id, p] of Hub.players) if (!p.online) Hub.players.delete(id);   // 離線的人移出名單
  setPhase('lobby');
  renderLobby();
}

$('startBtn').onclick = startSelectedGame;
$('homeBtn').onclick = () => { if (confirm('確定要回大廳嗎？這一場會結束。')) backToLobby(); };

// ============================================================
// Socket 事件
// ============================================================
// 手機加入（或重整後重新加入）
socket.on('player:join', ({ playerId, name, photo }) => {
  let p = Hub.players.get(playerId);
  if (p) {
    p.name = name; p.online = true; // 同一個 playerId = 同一個人，沿用原本資料
  } else {
    p = { id: playerId, name, online: true, charId: null, color: null };
    Hub.players.set(playerId, p);
  }
  p.photo = photo || '';
  if (p.photo) CharRender.loadHead(p, p.photo);
  sendStatus(p);
  broadcastState();
  renderLobby();
  if (Hub.currentGame && Hub.currentGame.onPlayerJoin) Hub.currentGame.onPlayerJoin(p);   // 遊戲中重連
});

// 玩家斷線
socket.on('player:left', ({ playerId }) => {
  const p = Hub.players.get(playerId);
  if (!p) return;
  if (Hub.phase === 'lobby') { Hub.players.delete(playerId); broadcastState(); } // 大廳直接移除（顏色也釋出）
  else p.online = false;                            // 遊戲中保留位置，只標示離線
  renderLobby();
  if (Hub.currentGame && Hub.currentGame.onPlayerLeft) Hub.currentGame.onPlayerLeft(p);
});

// 玩家按鍵（tap：跑步的左右鍵）與持續輸入（input：足球的搖桿與按鈕）：都交給目前的遊戲處理
for (const type of ['tap', 'input']) {
  socket.on(type, (data) => {
    if (Hub.currentGame && Hub.currentGame.onInput) Hub.currentGame.onInput(data.playerId, data);
  });
}

// 玩家選角色與衣服顏色：角色可重複，顏色不能重複（先選先贏）
socket.on('player:pick', ({ playerId, charId, color }) => {
  const p = Hub.players.get(playerId);
  if (!p) return;
  const valid = Hub.characters.some((c) => c.id === charId) && Hub.colors.includes(color);
  const taken = [...Hub.players.values()].some((o) => o !== p && o.color === color);
  if (!valid || taken) {
    socket.emit('player:status', { playerId, status: { ...statusOf(p), pickError: true } });
    return;
  }
  p.charId = charId; p.color = color;
  sendStatus(p);
  broadcastState();      // 通知所有手機這個顏色被選走了
  renderLobby();
});

// ============================================================
// 啟動：讀角色資料 → 建立房間 → 顯示房號與 QR Code
// ============================================================
let created = false;
socket.on('connect', async () => {
  if (created) { $('info').textContent = '⚠ 連線中斷過，請重新整理頁面建立新房間'; return; }
  created = true;
  const cfg = await (await fetch('characters.json')).json();
  Hub.characters = cfg.characters;
  Hub.colors = cfg.colors.map((c) => c.hex);
  Hub.characters.forEach(CharRender.makeCharHead);
  socket.emit('host:create', ({ room, controllerUrl }) => {
    roomCode = room;
    $('roomCode').textContent = room;
    $('url').textContent = controllerUrl;
    new QRCode($('qrcode'), { text: controllerUrl, width: 220, height: 220 });
    renderLobby();
    setPhase('lobby');
  });
});
