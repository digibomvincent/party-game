// ============================================================
// host.js － 主畫面。所有遊戲邏輯都在這裡：
//   玩家名單、分組、倒數、位置、名次、階段切換
// 階段 phase：lobby → countdown → racing → heatResult → (下一組 countdown ...) → result
// ============================================================

// ---------- 遊戲數值（要調整手感改這裡）----------
const TRACK_LENGTH = 1000;       // 跑道長度（抽象單位）
const STEP_DISTANCE = 25;        // 每按一下前進的距離（1000/25 = 要按 40 下）
const PLAYERS_PER_HEAT = 4;      // 每組幾人一起跑
const COUNTDOWN_SECONDS = 3;     // 倒數秒數
const FINISH_TIMEOUT_MS = 10000; // 第一名抵達後，最多再等幾毫秒就結束這一組
const HEAT_MAX_MS = 90000;       // 保險：一組最久跑多久（避免沒人到終點卡住）

// 畫面排版（Phaser 畫布大小 1280x720）
const CANVAS_W = 1280, CANVAS_H = 720;
const LANE_COUNT = PLAYERS_PER_HEAT;
const LANE_TOP = 110, LANE_HEIGHT = 120;
const START_X = 150, FINISH_X = 1140, BLOCK_SIZE = 70;

// ---------- 遊戲狀態 ----------
const socket = io();
const players = new Map();   // playerId -> { id, name, online, heat, lane, char, pos, finished, finishTime, heatRank, overallRank }
let characters = [];         // 角色資料（characters.json）
let phase = 'lobby';
let heats = [];              // 每一組的 playerId 陣列，例如 [[a,b,c,d],[e,f]]
let currentHeat = -1;        // 目前跑第幾組（從 0 開始）
let goTime = 0;              // 這一組 GO 的時間點
let timers = [];             // 目前進行中的計時器，換階段時清掉
let roomCode = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// 畫面層（Phaser）：只負責「畫」，資料都從 view 讀
// ============================================================
const view = { version: 0, racers: [], countdown: '', title: '' };

class RaceScene extends Phaser.Scene {
  create() {
    this.version = -1;
    this.sprites = [];

    // 畫跑道：每條交錯深淺色
    for (let i = 0; i < LANE_COUNT; i++) {
      const y = LANE_TOP + i * LANE_HEIGHT;
      this.add.rectangle(CANVAS_W / 2, y + LANE_HEIGHT / 2, CANVAS_W - 40, LANE_HEIGHT - 6,
        i % 2 ? 0x24384d : 0x2c4560);
    }
    // 起跑線與終點線（終點線畫成黑白格）
    this.add.rectangle(START_X - BLOCK_SIZE / 2 - 10, CANVAS_H / 2, 4, LANE_COUNT * LANE_HEIGHT, 0xffffff);
    const finishLineX = FINISH_X + BLOCK_SIZE / 2 + 10;
    for (let r = 0; r < LANE_COUNT * 6; r++) {
      this.add.rectangle(finishLineX + (r % 2 ? 10 : 0), LANE_TOP + 10 + r * 20, 10, 20, 0xffffff);
      this.add.rectangle(finishLineX + (r % 2 ? 0 : 10), LANE_TOP + 10 + r * 20, 10, 20, 0x111111);
    }
    this.titleText = this.add.text(CANVAS_W / 2, 55, '', { fontSize: '44px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
    this.cdText = this.add.text(CANVAS_W / 2, CANVAS_H / 2, '', { fontSize: '220px', color: '#fff', fontStyle: 'bold',
      stroke: '#000', strokeThickness: 12 }).setOrigin(0.5).setDepth(10);
  }

  // 依 view.racers 重建本組玩家的色塊
  rebuild() {
    this.sprites.forEach((s) => { s.block.destroy(); s.label.destroy(); });
    this.sprites = view.racers.map((p) => {
      const y = LANE_TOP + p.lane * LANE_HEIGHT + LANE_HEIGHT / 2;
      const block = this.add.rectangle(START_X, y + 10, BLOCK_SIZE, BLOCK_SIZE, Phaser.Display.Color.HexStringToColor(p.char.color).color)
        .setStrokeStyle(4, 0xffffff);
      const label = this.add.text(START_X, y - 38, p.name, { fontSize: '24px', color: '#fff' }).setOrigin(0.5);
      return { p, block, label };
    });
    this.version = view.version;
  }

  update() {
    if (this.version !== view.version) this.rebuild();
    this.titleText.setText(view.title);
    this.cdText.setText(view.countdown);
    // 色塊平滑移向目標位置
    for (const s of this.sprites) {
      const targetX = START_X + (s.p.pos / TRACK_LENGTH) * (FINISH_X - START_X);
      s.block.x += (targetX - s.block.x) * 0.25;
      s.label.x = s.block.x;
      s.label.setText(s.p.finished ? `${s.p.name}  第${s.p.heatRank}名` : s.p.name);
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', width: CANVAS_W, height: CANVAS_H, backgroundColor: '#101820',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: RaceScene,
});

// 換一組玩家上場（通知畫面重建色塊）
function showRacers(list) {
  view.racers = list;
  view.version++;
}

// ============================================================
// 工具函式
// ============================================================
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
function fmtTime(ms) { return (ms / 1000).toFixed(2) + ' 秒'; }
function heatPlayers() { return (heats[currentHeat] || []).map((id) => players.get(id)); }
function onlinePlayers() { return [...players.values()].filter((p) => p.online); }

// ============================================================
// 對外溝通：廣播階段、傳個人狀態
// ============================================================
// 切換階段：更新畫面面板 + 廣播給所有手機
function setPhase(next) {
  phase = next;
  socket.emit('game:state', { phase, heat: currentHeat + 1, totalHeats: heats.length });
  $('lobby').classList.toggle('hidden', phase !== 'lobby');
  $('heatPanel').classList.toggle('hidden', phase !== 'heatResult');
  $('finalPanel').classList.toggle('hidden', phase !== 'result');
  $('hud').textContent = (phase === 'lobby' || phase === 'result') ? '' : `第 ${currentHeat + 1} / ${heats.length} 組`;
  sendAllStatus();
}

// 組出要傳給某位玩家手機的個人狀態
function statusOf(p) {
  return {
    role: p.heat === null ? 'late' : (p.heat === currentHeat ? 'racer' : 'waiting'), // late = 本場中途才加入
    heat: p.heat === null ? null : p.heat + 1,
    totalHeats: heats.length,
    color: p.char ? p.char.color : '#888888',
    finished: p.finished,
    heatRank: p.heatRank,
    overallRank: p.overallRank,
    finishTime: p.finishTime,
  };
}
function sendStatus(p) { socket.emit('player:status', { playerId: p.id, status: statusOf(p) }); }
function sendAllStatus() { players.forEach((p) => p.online && sendStatus(p)); }

// ============================================================
// 大廳
// ============================================================
function renderLobby() {
  const list = onlinePlayers();
  $('count').textContent = list.length;
  $('playerList').innerHTML = list.map((p) => `<li>${escapeHtml(p.name)}</li>`).join('');
  $('startBtn').disabled = list.length < 1;
  const heatCount = Math.ceil(list.length / PLAYERS_PER_HEAT);
  $('info').textContent = list.length
    ? `共 ${list.length} 人，將分成 ${heatCount} 組（每組最多 ${PLAYERS_PER_HEAT} 人）`
    : '用手機掃 QR Code 加入';
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// 遊戲流程
// ============================================================
// 開始一整場：把在線玩家依加入順序分組，然後從第 1 組開始
function startGame() {
  // 離線的人這場不參加，直接移出名單
  for (const [id, p] of players) if (!p.online) players.delete(id);
  const list = [...players.values()];
  if (!list.length) return;

  players.forEach((p) => {
    p.heat = null; p.lane = 0; p.char = null; p.pos = 0;
    p.finished = false; p.finishTime = null; p.heatRank = null; p.overallRank = null;
  });
  heats = [];
  for (let i = 0; i < list.length; i += PLAYERS_PER_HEAT) {
    const group = list.slice(i, i + PLAYERS_PER_HEAT);
    group.forEach((p, lane) => {
      p.heat = heats.length;
      p.lane = lane;                                   // 第幾條跑道
      p.char = characters[lane % characters.length];   // 角色（色塊）依跑道決定
    });
    heats.push(group.map((p) => p.id));
  }
  startHeat(0);
}

// 開始第 n 組：顯示色塊 → 倒數 → 開跑
function startHeat(n) {
  clearTimers();
  currentHeat = n;
  showRacers(heatPlayers());
  view.title = `第 ${n + 1} / ${heats.length} 組`;
  setPhase('countdown');

  let count = COUNTDOWN_SECONDS;
  view.countdown = String(count);
  const tick = () => {
    count--;
    if (count > 0) {
      view.countdown = String(count);
      later(tick, 1000);
    } else {
      view.countdown = 'GO!';
      later(() => { view.countdown = ''; }, 800);
      beginRace();
    }
  };
  later(tick, 1000);
}

function beginRace() {
  goTime = Date.now();
  setPhase('racing');
  later(endHeat, HEAT_MAX_MS); // 保險計時器
}

// 收到某位玩家按鍵
function onTap(playerId) {
  const p = players.get(playerId);
  if (!p || phase !== 'racing' || p.heat !== currentHeat || p.finished) return;

  p.pos = Math.min(TRACK_LENGTH, p.pos + STEP_DISTANCE);
  if (p.pos < TRACK_LENGTH) return;

  // 抵達終點：記錄時間與本組名次
  p.finished = true;
  p.finishTime = Date.now() - goTime;
  p.heatRank = heatPlayers().filter((x) => x.finished).length;
  sendStatus(p);

  if (p.heatRank === 1) later(endHeat, FINISH_TIMEOUT_MS); // 第一名到了，開始 10 秒倒數
  checkHeatDone();
}

// 本組所有「還在線」的人都到終點了嗎？
function checkHeatDone() {
  if (phase !== 'racing') return;
  if (heatPlayers().every((p) => p.finished || !p.online)) endHeat();
}

// 結束這一組：沒跑完的人依目前位置排在後面，然後顯示本組結果
function endHeat() {
  if (phase !== 'racing') return;
  clearTimers();
  const group = heatPlayers();
  let rank = group.filter((p) => p.finished).length;
  group.filter((p) => !p.finished).sort((a, b) => b.pos - a.pos).forEach((p) => { p.heatRank = ++rank; });

  const sorted = [...group].sort((a, b) => a.heatRank - b.heatRank);
  $('heatTitle').textContent = `第 ${currentHeat + 1} 組結果`;
  $('heatList').innerHTML = sorted.map((p) =>
    `<li><span>${p.heatRank}. ${escapeHtml(p.name)}</span>` +
    (p.finished ? `<span>${fmtTime(p.finishTime)}</span>` : `<span class="dnf">沒跑完</span>`) + `</li>`).join('');

  const isLast = currentHeat + 1 >= heats.length;
  if (isLast) {
    $('nextInfo').textContent = '全部組別都跑完了！';
    $('nextBtn').textContent = '看總成績';
  } else {
    const names = heats[currentHeat + 1].map((id) => players.get(id).name).join('、');
    $('nextInfo').textContent = `下一組：${names}`;
    $('nextBtn').textContent = `開始第 ${currentHeat + 2} 組`;
  }
  setPhase('heatResult');
}

// 全部跑完：依「抵達時間」排總名次，沒跑完的排最後（依位置）
function showFinal() {
  const all = [...players.values()].filter((p) => p.heat !== null);
  const done = all.filter((p) => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const dnf = all.filter((p) => !p.finished).sort((a, b) => b.pos - a.pos);
  [...done, ...dnf].forEach((p, i) => { p.overallRank = i + 1; });

  $('finalList').innerHTML = [...done, ...dnf].map((p) =>
    `<li><span>${p.overallRank}. ${escapeHtml(p.name)}</span>` +
    (p.finished ? `<span>${fmtTime(p.finishTime)}（第 ${p.heat + 1} 組）</span>` : `<span class="dnf">沒跑完</span>`) + `</li>`).join('');
  setPhase('result');
}

// ============================================================
// 按鈕
// ============================================================
$('startBtn').onclick = startGame;
$('againBtn').onclick = startGame; // 再來一場：重新分組、重新倒數
$('nextBtn').onclick = () => {
  if (currentHeat + 1 < heats.length) startHeat(currentHeat + 1);
  else showFinal();
};

// ============================================================
// Socket 事件
// ============================================================
// 手機加入（或重整後重新加入）
socket.on('player:join', ({ playerId, name }) => {
  let p = players.get(playerId);
  if (p) {
    p.name = name; p.online = true; // 同一個 playerId = 同一個人，沿用原本資料
  } else {
    p = { id: playerId, name, online: true, heat: null, lane: 0, char: null, pos: 0,
      finished: false, finishTime: null, heatRank: null, overallRank: null };
    players.set(playerId, p);
  }
  sendStatus(p);
  renderLobby();
});

// 玩家斷線
socket.on('player:left', ({ playerId }) => {
  const p = players.get(playerId);
  if (!p) return;
  if (phase === 'lobby') players.delete(playerId); // 大廳直接移除
  else p.online = false;                            // 遊戲中保留位置，只標示離線
  renderLobby();
  checkHeatDone();
});

// 玩家按鍵
socket.on('tap', ({ playerId }) => onTap(playerId));

// ============================================================
// 啟動：讀角色資料 → 建立房間 → 顯示房號與 QR Code
// ============================================================
let created = false;
socket.on('connect', async () => {
  if (created) { $('info').textContent = '⚠ 連線中斷過，請重新整理頁面建立新房間'; return; }
  created = true;
  characters = await (await fetch('characters.json')).json();
  socket.emit('host:create', ({ room, controllerUrl }) => {
    roomCode = room;
    $('roomCode').textContent = room;
    $('url').textContent = controllerUrl;
    new QRCode($('qrcode'), { text: controllerUrl, width: 220, height: 220 });
    renderLobby();
    setPhase('lobby');
  });
});
