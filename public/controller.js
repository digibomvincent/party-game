// ============================================================
// controller.js － 手機控制器
// 流程：加入房間 → 選角色 → 選衣服顏色 → 等開始 → 左右交替連按
// 只負責：送出選擇與按鍵，依 host 傳來的狀態顯示畫面（遊戲規則都在 host.js）
// ============================================================
const socket = io();
const $ = (id) => document.getElementById(id);

const PHOTO_ENABLED = false; // 大頭照功能先隱藏；要開回來改成 true
const SIMUL_MS = 80;         // 左右鍵在這個時間內先後按下，視為「同時按」

// ---------- 身分：playerId 存 localStorage，重整後還是同一個人 ----------
// 注意：區網 http 不是安全環境，不能用 crypto.randomUUID，所以自己組一個隨機字串
function getPlayerId() {
  let id = localStorage.getItem('party-race-playerId');
  if (!id) {
    id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('party-race-playerId', id);
  }
  return id;
}
const playerId = getPlayerId();

let joined = false;     // 是否已加入（斷線重連時要重新送 player:join）
let session = null;     // { room, name }
let gameState = { phase: 'lobby', heat: 0, totalHeats: 0, taken: [] };  // host 廣播的階段、已被選走的顏色
let status = null;                                                       // host 傳給我的個人狀態
let cfg = { characters: [], colors: [] };                                // characters.json
let pickStep = 'char';  // 選角色畫面目前在哪一步：char（選角色）/ color（選顏色）
let pickedChar = null;  // 這次選的角色 id
let repicking = false;  // 已選過，但按了「改角色 / 顏色」
let pickMsg = '';

fetch('characters.json').then((r) => r.json()).then((d) => { cfg = d; render(); });

// ---------- 畫面切換：加入 / 選角色 / 遊戲，一次只顯示一個 ----------
function show(name) {
  $('joinScreen').classList.toggle('hidden', name !== 'join');
  $('pickScreen').classList.toggle('hidden', name !== 'pick');
  $('playScreen').classList.toggle('hidden', name !== 'play');
}

// ---------- 大頭照（目前隱藏）：拍照 / 選圖 → 置中裁成正方形 → 縮成 128px JPEG，存 localStorage ----------
const PHOTO_SIZE = 128;
const PHOTO_KEY = 'party-race-photo';
function getPhoto() { return PHOTO_ENABLED ? (localStorage.getItem(PHOTO_KEY) || '') : ''; }
function showPhoto() {
  const photo = getPhoto();
  $('photoBtn').style.backgroundImage = photo ? `url(${photo})` : '';
  $('photoBtn').classList.toggle('has', !!photo);
}
$('photoBtn').classList.toggle('hidden', !PHOTO_ENABLED);
showPhoto();
$('photoBtn').onclick = () => $('photoInput').click();
$('photoInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const side = Math.min(img.width, img.height);
    const c = document.createElement('canvas');
    c.width = c.height = PHOTO_SIZE;
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    try { localStorage.setItem(PHOTO_KEY, c.toDataURL('image/jpeg', 0.8)); } catch (err) { /* 存不了就只有這次有效 */ }
    showPhoto();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
  e.target.value = ''; // 同一張照片可再選一次
};

// ---------- 加入 ----------
const params = new URLSearchParams(location.search);
$('roomInput').value = params.get('room') || '';           // 房號自動帶入
$('nameInput').value = localStorage.getItem('party-race-name') || '';

function join(room, name) {
  socket.emit('player:join', { room, playerId, name, photo: getPhoto() }, (res) => {
    if (res && res.ok) {
      joined = true;
      session = { room, name };
      localStorage.setItem('party-race-name', name);
      localStorage.setItem('party-race-session', JSON.stringify(session));
      show('play');
      render();
      requestWakeLock();
    } else {
      // 加入失敗（房號錯 / host 已關掉）：回到加入畫面
      joined = false;
      localStorage.removeItem('party-race-session');
      show('join');
      $('joinError').textContent = (res && res.error) || '加入失敗';
    }
  });
}

$('joinBtn').onclick = () => {
  const room = $('roomInput').value.trim();
  const name = $('nameInput').value.trim();
  if (room.length !== 4) { $('joinError').textContent = '請輸入 4 位數房號'; return; }
  if (!name) { $('joinError').textContent = '請輸入暱稱'; return; }
  $('joinError').textContent = '';
  join(room, name);
};

// 連線（含斷線後自動重連）：如果之前加入過，用同一個 playerId 重新加入
socket.on('connect', () => {
  const saved = JSON.parse(localStorage.getItem('party-race-session') || 'null');
  const urlRoom = params.get('room');
  if (saved && (!urlRoom || urlRoom === saved.room)) join(saved.room, saved.name);
});

// ---------- 接收 host 的訊息 ----------
socket.on('game:state', (s) => { gameState = s; render(); });
socket.on('player:status', (s) => {
  status = s;
  if (s.pickError) {            // 顏色剛被別人選走：回到選顏色那一步
    repicking = true; pickStep = 'color'; pickMsg = '這個顏色剛被選走了，換一個吧';
  }
  render();
});
socket.on('room:closed', () => {
  joined = false;
  localStorage.removeItem('party-race-session');
  show('play');
  setScreen('房間已關閉', '已結束', false);
});

// ---------- 選角色、選衣服顏色 ----------
// 上方大圖 = 目前選到的角色（art）；下排小方格 = 各角色的頭（head）。沒有圖檔的角色用預設臉。
function setBigArt(c, i) {
  const box = $('bigArt');
  box.innerHTML = '';
  const fallback = () => {                                     // 沒有大圖：畫大一點的預設臉（有 head 就用 head）
    const cv = document.createElement('canvas');
    cv.width = cv.height = 300;
    CharArt.drawFace(cv.getContext('2d'), 300, i);
    CharArt.loadImage(c, (img) => { const g = cv.getContext('2d'); g.clearRect(0, 0, 300, 300); CharArt.drawImage(g, img, 300); });
    box.replaceChildren(cv);
  };
  if (!c.art) { fallback(); return; }
  const img = new Image();
  img.onerror = fallback;
  img.src = c.art;
  box.append(img);
}
function selectChar(id) {
  pickedChar = id;
  const i = Math.max(0, cfg.characters.findIndex((c) => c.id === id));
  setBigArt(cfg.characters[i], i);
  [...$('pickGrid').children].forEach((el, k) => el.classList.toggle('sel', k === i));
  const sel = $('pickGrid').children[i];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });   // 把選到的那個捲到中間
}
function renderPick() {
  const grid = $('pickGrid');
  grid.innerHTML = '';
  $('pickMsg').textContent = pickMsg;
  $('pickBack').classList.toggle('hidden', pickStep !== 'color');
  $('pickOk').classList.toggle('hidden', pickStep !== 'char');
  grid.className = pickStep === 'char' ? 'chars' : 'colors';
  if (!cfg.characters.length) return;
  if (!cfg.characters.some((c) => c.id === pickedChar)) pickedChar = cfg.characters[0].id;

  if (pickStep === 'char') {
    $('pickTitle').textContent = '選你的角色';
    cfg.characters.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'charBtn';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 120;
      CharArt.drawFace(cv.getContext('2d'), 120, i);           // 先畫預設臉
      CharArt.loadImage(c, (img) => {                           // 有 head 圖就換成頭
        const g = cv.getContext('2d');
        g.clearRect(0, 0, 120, 120);
        CharArt.drawImage(g, img, 120);
      });
      b.append(cv);
      b.onclick = () => selectChar(c.id);
      grid.append(b);
    });
    selectChar(pickedChar);
  } else {
    $('pickTitle').textContent = '選衣服顏色';
    const i = cfg.characters.findIndex((c) => c.id === pickedChar);
    setBigArt(cfg.characters[i], i);
    const mine = status && status.color;
    cfg.colors.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'colorBtn';
      b.style.background = c.hex;
      const taken = (gameState.taken || []).includes(c.hex) && c.hex !== mine;   // 別人選走的不能選
      b.disabled = taken;
      if (taken) b.textContent = '✕';
      b.onclick = () => {
        socket.emit('player:pick', { charId: pickedChar, color: c.hex });
        repicking = false; pickMsg = ''; pickStep = 'char';
      };
      grid.append(b);
    });
  }
}
// 在大圖上左右滑動也可以切換角色
{
  let x0 = null;
  const art = $('bigArt');
  art.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  art.addEventListener('touchend', (e) => {
    if (x0 == null || pickStep !== 'char' || !cfg.characters.length) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) < 40) return;
    const i = Math.max(0, cfg.characters.findIndex((c) => c.id === pickedChar));
    const next = Math.min(cfg.characters.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)));
    if (next !== i) selectChar(cfg.characters[next].id);
  }, { passive: true });
}
$('pickOk').onclick = () => { pickStep = 'color'; pickMsg = ''; renderPick(); };
$('pickBack').onclick = () => { pickStep = 'char'; pickMsg = ''; renderPick(); };
$('repickBtn').onclick = () => { repicking = true; pickStep = 'char'; pickMsg = ''; render(); };

// ---------- 依狀態更新畫面 ----------
// enabled：false = 一顆鎖住的大按鈕（等待、結果）；true = 跑步的左右兩顆；'stick' = 搖桿；
//          'ready' = 陀螺大戰的「準備好」；'gyro' = 陀螺大戰的傾斜操控畫面
function setScreen(msg, btnText, enabled, color) {
  $('msg').innerHTML = `<div>${msg}</div>`;
  $('pad').classList.toggle('hidden', enabled !== true);
  $('soccerPad').classList.toggle('hidden', enabled !== 'stick');
  $('readyPad').classList.toggle('hidden', enabled !== 'ready');
  $('gyroPad').classList.toggle('hidden', enabled !== 'gyro');
  updateGyroTimer(enabled === 'gyro');
  $('bigBtn').classList.toggle('hidden', !!enabled);
  if (enabled !== 'stick') releaseAll();
  $('bigBtn').textContent = btnText;
  $('bigBtn').disabled = true;
  if (color) for (const el of [$('bigBtn'), $('btnL'), $('btnR'), $('stickKnob'), $('btnNeck'), $('btnDash'), $('btnReadyGyro'), $('tiltBubble')]) el.style.setProperty('--c', color);
  if (!enabled) { lastSide = null; updateNext(); }
}

// 重生倒數：手機只在「死掉」和「復活」時才收到狀態，中間的秒數在手機上自己倒數
let respawnTimer = null, respawnEnd = 0;
function startRespawnTicker(ms) {
  clearInterval(respawnTimer);
  if (!ms) return;
  respawnEnd = performance.now() + ms;
  respawnTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((respawnEnd - performance.now()) / 1000));
    $('bigBtn').textContent = left > 0 ? `重生中 ${left}` : '重生中…';
    if (left <= 0) clearInterval(respawnTimer);
  }, 250);
}

function render() {
  if (!joined) return;
  const { phase, heat: cur, totalHeats } = gameState;
  const me = status;
  if (!me) { show('play'); setScreen('連線中…', '等待中', false); return; }

  // 還沒選角色 / 顏色，或按了「改角色 / 顏色」：顯示選擇畫面
  if (!me.picked || repicking) {
    show('pick'); renderPick(); return;
  }
  show('play');
  $('repickBtn').classList.toggle('hidden', !(phase === 'lobby' || me.role === 'late'));

  const color = me.color;
  const time = me.finishTime != null ? `（${(me.finishTime / 1000).toFixed(2)} 秒）` : '';
  const who = `你是 <b>${me.charName || ''}</b> <span class="dot" style="background:${color}"></span>`;

  if (phase === 'lobby') { setScreen(`${who}<br>等主持人選遊戲、按開始…`, '等待中', false, color); return; }
  if (me.role === 'late') {            // 本場開始後才加入
    setScreen('本場已經開始了<br>下一場再一起跑！', '等待中', false, color); return;
  }
  $('soccerPad').classList.toggle('solo', gameState.game === 'spinner');   // 陀螺大戰沒有頭槌／衝刺；足球有（換遊戲時要記得切回來）
  if (gameState.game === 'soccer') {   // 足球：整塊畫面是搖桿；比賽結束顯示勝負
    const sc = gameState.score || [0, 0];
    const board = `<span style="color:#f87171">紅 ${sc[0]}</span> : <span style="color:#60a5fa">${sc[1]} 藍</span>`;
    const team = me.team ? `<b style="color:${me.team === 'red' ? '#f87171' : '#60a5fa'}">${me.teamName}</b>` : '';
    if (phase === 'result') {
      const text = { win: '你們贏了！', lose: '這場輸了', draw: '平手' }[me.result] || '比賽結束';
      setScreen(`${board}<br>${team}　${text}`, { win: '勝利', lose: '落敗', draw: '平手' }[me.result] || '結束', false, color); return;
    }
    const hint = phase === 'countdown' ? '預備…' : phase === 'goal' ? '進球！' : '頭槌把球打進對方球門';
    setScreen(`${board}<br>你是 ${team}　<small>${hint}</small>`, '', 'stick', color); return;
  }
  if (gameState.game === 'spinner') {  // 陀螺大戰：傾斜手機（陀螺儀）或搖桿
    const rd = me.round || gameState.round || 1;
    const head = `第 ${rd} 回合　<b>${me.kills || 0}</b> 殺`;
    if (phase === 'result') {
      const text = me.finalRank ? (me.eliminated ? `第 ${me.finalRank} 名` : `最後留下來！第 ${me.finalRank} 名 🏆`) : '比賽結束';
      setScreen(`${text}<br><small>共擊殺 ${me.kills || 0} 人</small>`, me.finalRank ? `第 ${me.finalRank} 名` : '結束', false, color); return;
    }
    if (phase === 'roundEnd') {
      setScreen(`第 1 回合結束<br>你是第 <b>${me.roundRank || '-'}</b> 名（${me.kills || 0} 殺）`, '休息一下', false, color); return;
    }
    if (me.eliminated) { setScreen(`你被淘汰了<br><small>看看誰能撐到最後</small>`, '淘汰', false, color); return; }
    if (!me.alive && phase === 'playing') {
      startRespawnTicker(me.respawnMs);
      setScreen(`被撞出去了！<br><small>${head}</small>`, '重生中…', false, color); return;
    }
    // 還沒選操控方式、或體感被重新整理掉了（iPhone 每次重整都要重新授權）：先回到「準備好」
    const needEnable = !ctrlMode || (ctrlMode === 'gyro' && !gyro.active);
    if (phase === 'prepare' && me.ready && !needEnable) {
      setScreen(`✅ 準備好了<br><small>${ctrlMode === 'gyro' ? '📱 體感操控' : '🕹 搖桿操控'}　等其他人…</small>${gyroNote ? `<br><small>${gyroNote}</small>` : ''}`, '等待中', false, color); return;
    }
    if (needEnable) {
      setScreen(`${phase === 'prepare' ? '準備好了嗎？' : '點一下啟用體感'}<br><small>按下「準備好」會請你允許「動作與方向」。<br>把手機拿成你習慣的姿勢，按下的那一刻就是「水平」</small>`, '', 'ready', color); return;
    }
    const hint = phase === 'countdown' ? '預備…' : rd === 1 ? '把別人撞出平台，被撞出去 5 秒後復活' : '最後留下來的人獲勝，不會復活！';
    setScreen(`${head}<br><small>${hint}${gyroNote ? '<br>' + gyroNote : ''}</small>`, '', ctrlMode === 'gyro' ? 'gyro' : 'stick', color); return;
  }
  if (phase === 'result') {            // 全部跑完：顯示總名次
    setScreen(me.finished ? `全部結束！你的總名次` + time : '全部結束！你沒跑完',
      me.overallRank ? `第 ${me.overallRank} 名` : '—', false, color); return;
  }
  const mine = me.heat;
  if (mine < cur || (mine === cur && phase === 'heatResult')) {   // 我這組已經跑完
    setScreen(me.finished ? `你是本組第 ${me.heatRank} 名${time}<br>等其他組跑完…` : '你沒跑完<br>等其他組跑完…',
      me.finished ? `第 ${me.heatRank} 名` : '沒跑完', false, color); return;
  }
  if (mine > cur) {                    // 還沒輪到我
    setScreen(`你在第 ${mine} / ${totalHeats} 組<br>現在跑第 ${cur} 組，請準備`, '等待中', false, color); return;
  }
  // 以下：輪到我這組
  if (phase === 'countdown') { setScreen('預備…<br>左、右、左、右 交替按！', '預備', false, color); return; }
  if (phase === 'racing') {
    if (me.finished) setScreen(`到達終點！本組第 ${me.heatRank} 名${time}`, `第 ${me.heatRank} 名`, false, color);
    else setScreen('左右交替按！<br><small>別同時按、別連按同一邊</small>', '', true, color);
  }
}

// ---------- 左右兩顆按鈕：按下送 tap（side = L / R；兩顆幾乎同時按下送 both）----------
const lastDown = { L: 0, R: 0 };  // 左右鍵最近一次按下的時間
let lastSide = null;              // 我上一次按的是哪一邊（用來提示下一顆該按哪邊）

function updateNext() {
  // 提示：剛按完左邊，右邊就亮起來
  $('btnL').classList.toggle('next', lastSide === 'R');
  $('btnR').classList.toggle('next', lastSide === 'L');
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); } // 不支援的手機（如 iPhone）就略過

function press(side, e) {
  e.preventDefault();
  const btn = side === 'L' ? $('btnL') : $('btnR');
  btn.classList.add('pressed');
  const now = performance.now(), other = side === 'L' ? 'R' : 'L';
  if (now - lastDown[other] < SIMUL_MS) {   // 兩邊同時按：會跌倒
    socket.emit('tap', { side: 'both' });
    vibrate([80, 40, 80]);
    lastDown.L = lastDown.R = 0;
    lastSide = null; updateNext();
    return;
  }
  lastDown[side] = now;
  lastSide = side; updateNext();
  socket.emit('tap', { side });
  vibrate(20);
}
for (const [side, id] of [['L', 'btnL'], ['R', 'btnR']]) {
  const btn = $(id);
  btn.addEventListener('pointerdown', (e) => press(side, e));
  const release = () => btn.classList.remove('pressed');
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
}
document.addEventListener('contextmenu', (e) => e.preventDefault()); // 禁止長按選單

// ---------- 足球：浮動搖桿 + 頭槌 / 衝刺按鈕（送 input 事件 { mx, my, dash, neck }）----------
const STICK_R = 60;            // 搖桿拖到這個距離（像素）就是推到底
const STICK_DEAD = 0.15;       // 死區：太小的移動當作沒動，避免手指微抖
const STICK_SEND_MS = 50;      // 拖動時最多每 50ms 送一次
const KEEPALIVE_MS = 150;      // 有東西按住時也定期重送整組輸入，host 才不會以為斷線
let stick = null;              // 目前按著搖桿的手指 { id, x0, y0, mx, my }
const held = { neck: false, dash: false, ax: 0, ay: 0 };   // 頭槌（含右手滑動的瞄準方向）、衝刺是否按著
let sentAt = 0, keepTimer = null;

function sendInput() {
  const r2 = (v) => Math.round(v * 100) / 100;
  socket.emit('input', { mx: r2(stick ? stick.mx : 0), my: r2(stick ? stick.my : 0), dash: held.dash, neck: held.neck, ax: r2(held.neck ? held.ax : 0), ay: r2(held.neck ? held.ay : 0) });
  sentAt = performance.now();
}
// 有任何東西按著就定期重送；全部放開就停
function updateKeepAlive() {
  const active = !!stick || held.neck || held.dash;
  if (active && !keepTimer) keepTimer = setInterval(sendInput, KEEPALIVE_MS);
  if (!active && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}
function releaseStick() {
  if (!stick) return;
  stick = null;
  $('stickBase').classList.add('hidden');
  $('stickHint').classList.remove('hidden');
  updateKeepAlive(); sendInput();
}
function releaseAll() {          // 離開足球畫面 / 分頁被切走：搖桿與按鈕全部放開並通知 host
  const any = !!stick || held.neck || held.dash;
  stick = null; held.neck = held.dash = false; held.ax = held.ay = 0;
  $('aimBase').classList.add('hidden');
  $('stickBase').classList.add('hidden'); $('stickHint').classList.remove('hidden');
  for (const id of ['btnNeck', 'btnDash']) $(id).classList.remove('pressed');
  updateKeepAlive();
  if (any) sendInput();
}

const zone = $('stickZone');
zone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (stick) return;
  zone.setPointerCapture(e.pointerId);               // 手指拖出範圍也不會斷
  const rect = zone.getBoundingClientRect();
  stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mx: 0, my: 0 };
  const base = $('stickBase');
  base.style.left = (e.clientX - rect.left) + 'px';
  base.style.top = (e.clientY - rect.top) + 'px';
  base.classList.remove('hidden');
  $('stickKnob').style.transform = 'translate(-50%, -50%)';
  $('stickHint').classList.add('hidden');
  updateKeepAlive();
});
zone.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  let dx = (e.clientX - stick.x0) / STICK_R, dy = (e.clientY - stick.y0) / STICK_R;
  const mag = Math.hypot(dx, dy);
  if (mag > 1) { dx /= mag; dy /= mag; }
  $('stickKnob').style.transform = `translate(calc(-50% + ${dx * STICK_R}px), calc(-50% + ${dy * STICK_R}px))`;
  const live = Math.min(mag, 1) >= STICK_DEAD;
  stick.mx = live ? dx : 0; stick.my = live ? dy : 0;
  if (performance.now() - sentAt >= STICK_SEND_MS) sendInput();
});
for (const ev of ['pointerup', 'pointercancel']) {
  zone.addEventListener(ev, (e) => { if (stick && e.pointerId === stick.id) releaseStick(); });
}

// 衝刺（按下就觸發）
{
  const btn = $('btnDash');
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); btn.setPointerCapture(e.pointerId);
    held.dash = true; btn.classList.add('pressed'); updateKeepAlive(); sendInput(); vibrate([25]);
  });
  const up = () => { if (!held.dash) return; held.dash = false; btn.classList.remove('pressed'); updateKeepAlive(); sendInput(); };
  btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
}

// 頭槌：按住蓄力，在這塊區域「像搖桿一樣滑動」指定要把球打去哪個方向，放開就打出去。
//       球在角色附近時，頭會直接衝向球，球則照你滑的方向飛；沒滑（單純按住放開）就用目前的移動方向。
const AIM_R = 60, AIM_DEAD_UI = 0.2;
{
  const pad = $('btnNeck'), base = $('aimBase'), knob = $('aimKnob');
  let aim = null;                                   // { id, x0, y0 }
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (aim) return;
    pad.setPointerCapture(e.pointerId);
    const rect = pad.getBoundingClientRect();
    aim = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    held.neck = true; held.ax = held.ay = 0; pad.classList.add('pressed');
    base.style.left = (e.clientX - rect.left) + 'px'; base.style.top = (e.clientY - rect.top) + 'px';
    knob.style.transform = 'translate(-50%, -50%)'; base.classList.remove('hidden');
    updateKeepAlive(); sendInput(); vibrate([15]);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!aim || e.pointerId !== aim.id) return;
    let dx = (e.clientX - aim.x0) / AIM_R, dy = (e.clientY - aim.y0) / AIM_R;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    knob.style.transform = `translate(calc(-50% + ${dx * AIM_R * 0.55}px), calc(-50% + ${dy * AIM_R * 0.55}px))`;
    const live = Math.min(mag, 1) >= AIM_DEAD_UI;
    held.ax = live ? dx : 0; held.ay = live ? dy : 0;
    if (performance.now() - sentAt >= STICK_SEND_MS) sendInput();
  });
  const up = (e) => {
    if (!aim || e.pointerId !== aim.id) return;
    aim = null; held.neck = false;                  // 放開：host 用放開前最後一次的方向把球打出去
    pad.classList.remove('pressed'); base.classList.add('hidden');
    updateKeepAlive(); sendInput(); held.ax = held.ay = 0; vibrate([30]);
  };
  pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
}
// 分頁被切走時，搖桿與按鈕一定要放開，不然角色會一直跑或一直蓄力
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') releaseAll(); });

// ---------- 陀螺大戰：陀螺儀（傾斜手機）操控 ----------
// 原理：用 deviceorientation 的 beta（上緣抬起／壓下）與 gamma（右緣壓下／抬起）的「角度變化」：
//       現在的角度 - 「校正」時的角度，除以滿傾斜角，得到 -1~1 的方向向量，格式和搖桿一樣（mx, my），所以 host 不用知道是哪一種操控。
//       往哪邊傾斜，圓盤就往哪邊滾（像在手機上放一顆珠子）。
const TILT_FULL_DEG = 25;      // 傾斜到這個角度（相對校正姿勢）就是推到底
const TILT_DEAD = 0.1;         // 死區：傾斜太小當作沒傾斜（0~1）
const GYRO_SMOOTH = 0.35;      // 平滑（越大越跟手、越小越穩）
const GYRO_SEND_MS = 33;       // 最多每 33ms（30Hz）送一次
let ctrlMode = '';             // 'gyro' | 'stick' | ''（還沒選）
try { ctrlMode = localStorage.getItem('party-race-mode') || ''; } catch (e) { /* 略過 */ }
let gyroNote = '';             // 啟用失敗時要顯示的提示
const gyro = { active: false, listening: false, raw: { beta: 0, gamma: 0 }, neutral: { beta: 0, gamma: 0 }, hasNeutral: false, vec: { mx: 0, my: 0 }, sentAt: 0 };
let gyroTimer = null;

function setCtrlMode(m) { ctrlMode = m; try { localStorage.setItem('party-race-mode', m); } catch (e) { /* 略過 */ } }

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;       // 角度差換成 -180~180，避免跨過 ±180 時跳一大格
// 把「現在 - 校正姿勢」的角度差轉成 -1~1 的向量（含螢幕轉向、死區）；mx 往右為正、my 往下為正（和 host 畫面一致）
function tiltVector(raw, neutral, angle) {
  const dBeta = wrap180(raw.beta - neutral.beta), dGamma = wrap180(raw.gamma - neutral.gamma);
  const dx = dGamma, dy = -dBeta;                                      // 裝置座標：x 往右、y 往上（下坡方向）
  let sx, sy;                                                          // 換成螢幕座標（橫放時螢幕轉了 angle 度）
  switch (((angle % 360) + 360) % 360) {
    case 90: sx = -dy; sy = dx; break;
    case 180: sx = -dx; sy = -dy; break;
    case 270: sx = dy; sy = -dx; break;
    default: sx = dx; sy = dy;
  }
  let mx = sx / TILT_FULL_DEG, my = -sy / TILT_FULL_DEG;
  const mag = Math.hypot(mx, my);
  if (mag > 1) { mx /= mag; my /= mag; }
  const m = Math.min(1, mag);
  if (m < TILT_DEAD) return { mx: 0, my: 0 };
  const scale = (m - TILT_DEAD) / (1 - TILT_DEAD) / m;                 // 死區以外重新拉伸到 0~1
  return { mx: mx * scale, my: my * scale };
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;                       // 桌機瀏覽器沒有感測器時會送空值
  const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  gyro.active = true;
  gyro.raw = { beta: e.beta, gamma: e.gamma };
  if (!gyro.hasNeutral) { gyro.neutral = { ...gyro.raw }; gyro.hasNeutral = true; }
  const t = tiltVector(gyro.raw, gyro.neutral, angle);
  gyro.vec = { mx: gyro.vec.mx + (t.mx - gyro.vec.mx) * GYRO_SMOOTH, my: gyro.vec.my + (t.my - gyro.vec.my) * GYRO_SMOOTH };
  if (Math.hypot(gyro.vec.mx, gyro.vec.my) < 0.02) gyro.vec = { mx: 0, my: 0 };
  // 傾斜指示：泡泡往傾斜的方向移動
  const R = $('tiltRing').clientWidth * 0.39;
  $('tiltBubble').style.transform = `translate(calc(-50% + ${gyro.vec.mx * R}px), calc(-50% + ${gyro.vec.my * R}px))`;
  if (ctrlMode === 'gyro' && $('gyroPad') && !$('gyroPad').classList.contains('hidden') && performance.now() - gyro.sentAt >= GYRO_SEND_MS) sendGyro();
}
function sendGyro() {
  const r2 = (v) => Math.round(v * 100) / 100;
  socket.emit('input', { mx: r2(gyro.vec.mx), my: r2(gyro.vec.my), mode: 'gyro' });
  gyro.sentAt = performance.now();
}
// 傾斜畫面顯示時，就算手機放著不動也定期重送（host 超過 0.6 秒沒收到會當作回正）
function updateGyroTimer(on) {
  if (on && !gyroTimer) gyroTimer = setInterval(() => { if (ctrlMode === 'gyro') sendGyro(); }, 150);
  if (!on && gyroTimer) { clearInterval(gyroTimer); gyroTimer = null; }
}
function calibrate() {                                                  // 把現在的姿勢當作水平
  gyro.neutral = { ...gyro.raw }; gyro.hasNeutral = true; gyro.vec = { mx: 0, my: 0 };
  vibrate([20]);
}

// 請求陀螺儀：iPhone 要在「點擊」裡呼叫 requestPermission；其他手機直接聽事件。回傳 { ok, reason }
async function enableGyro() {
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };       // 只有 https（或 localhost）才給用感測器
  if (typeof DeviceOrientationEvent === 'undefined') return { ok: false, reason: 'unsupported' };
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return { ok: false, reason: 'denied' }; }
    catch (err) { return { ok: false, reason: 'denied' }; }
  }
  if (!gyro.listening) { window.addEventListener('deviceorientation', onOrientation); gyro.listening = true; }
  const got = await new Promise((resolve) => {                                  // 等第一筆有效資料；1.5 秒都沒有就當作這支手機沒有感測器
    let waited = 0;
    const iv = setInterval(() => {
      if (gyro.active) { clearInterval(iv); resolve(true); }
      else if ((waited += 100) >= 1500) { clearInterval(iv); resolve(false); }
    }, 100);
  });
  return got ? { ok: true } : { ok: false, reason: 'nodata' };
}
const GYRO_FAIL_NOTE = {
  insecure: '這個網址不是 https，手機不允許使用體感，已改用搖桿（請用 https 網址開）',
  unsupported: '這個瀏覽器不支援體感，已改用搖桿',
  denied: '你沒有允許「動作與方向」，已改用搖桿（iPhone 要到 Safari 的網站設定重設）',
  nodata: '偵測不到這支手機的陀螺儀，已改用搖桿',
};
function sendReady() { socket.emit('input', { mx: 0, my: 0, ready: true, mode: ctrlMode }); }

$('btnReadyGyro').addEventListener('click', async () => {
  const r = await enableGyro();               // 這一行在使用者點擊的事件裡，iPhone 才肯跳授權視窗
  if (r.ok) { calibrate(); setCtrlMode('gyro'); gyroNote = ''; }
  else { setCtrlMode('stick'); gyroNote = GYRO_FAIL_NOTE[r.reason] || ''; }
  sendReady(); render();
});
$('btnReadyStick').addEventListener('click', () => { setCtrlMode('stick'); gyroNote = ''; sendReady(); render(); });
$('btnCalib').addEventListener('click', calibrate);
$('btnToStick').addEventListener('click', () => { setCtrlMode('stick'); gyroNote = ''; socket.emit('input', { mx: 0, my: 0, mode: 'stick' }); render(); });

// ---------- Wake Lock：讓螢幕不要暗掉（不支援就略過）----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* 不支援或被拒絕，略過 */ }
}
// 切換分頁回來時，Wake Lock 會被系統釋放，要重新要
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined) requestWakeLock();
});
