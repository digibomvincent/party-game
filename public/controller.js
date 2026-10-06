// ============================================================
// controller.js － 手機控制器
// 只負責：加入房間、按鈕送 tap、依 host 傳來的狀態顯示文字
// ============================================================
const socket = io();
const $ = (id) => document.getElementById(id);

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
let gameState = { phase: 'lobby', heat: 0, totalHeats: 0 };  // host 廣播的階段
let status = null;                                            // host 傳給我的個人狀態

// ---------- 加入 ----------
const params = new URLSearchParams(location.search);
$('roomInput').value = params.get('room') || '';           // 房號自動帶入
$('nameInput').value = localStorage.getItem('party-race-name') || '';

function join(room, name) {
  socket.emit('player:join', { room, playerId, name }, (res) => {
    if (res && res.ok) {
      joined = true;
      session = { room, name };
      localStorage.setItem('party-race-name', name);
      localStorage.setItem('party-race-session', JSON.stringify(session));
      $('joinScreen').classList.add('hidden');
      $('playScreen').classList.remove('hidden');
      render();
      requestWakeLock();
    } else {
      // 加入失敗（房號錯 / host 已關掉）：回到加入畫面
      joined = false;
      localStorage.removeItem('party-race-session');
      $('joinScreen').classList.remove('hidden');
      $('playScreen').classList.add('hidden');
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
socket.on('player:status', (s) => { status = s; render(); });
socket.on('room:closed', () => {
  joined = false;
  localStorage.removeItem('party-race-session');
  setScreen('房間已關閉', '已結束', false);
});

// ---------- 依狀態更新畫面 ----------
function setScreen(msg, btnText, enabled, color) {
  $('msg').innerHTML = msg;
  $('bigBtn').textContent = btnText;
  $('bigBtn').disabled = !enabled;
  if (color) $('bigBtn').style.setProperty('--c', color);
}

function render() {
  if (!joined) return;
  const { phase, heat: cur, totalHeats } = gameState;
  const me = status;
  if (!me || phase === 'lobby') { setScreen('等主持人按開始…', '等待中', false); return; }

  const color = me.color;
  const time = me.finishTime != null ? `（${(me.finishTime / 1000).toFixed(2)} 秒）` : '';

  if (me.role === 'late') {            // 本場開始後才加入
    setScreen('本場已經開始了<br>下一場再一起跑！', '等待中', false); return;
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
    setScreen(`你在第 ${mine} / ${totalHeats} 組<br>現在跑第 ${cur} 組，請準備`, '等待中', false); return;
  }
  // 以下：輪到我這組
  if (phase === 'countdown') { setScreen('預備…', '預備', false, color); return; }
  if (phase === 'racing') {
    if (me.finished) setScreen(`到達終點！本組第 ${me.heatRank} 名${time}`, `第 ${me.heatRank} 名`, false, color);
    else setScreen('用力連打！', '連打！', true, color);
  }
}

// ---------- 大按鈕：按下送 tap ----------
const btn = $('bigBtn');
btn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (btn.disabled) return;
  btn.classList.add('pressed');
  socket.emit('tap');
  if (navigator.vibrate) navigator.vibrate(20); // 不支援的手機（如 iPhone）就略過
});
const release = () => btn.classList.remove('pressed');
btn.addEventListener('pointerup', release);
btn.addEventListener('pointercancel', release);
btn.addEventListener('pointerleave', release);
document.addEventListener('contextmenu', (e) => e.preventDefault()); // 禁止長按選單

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
