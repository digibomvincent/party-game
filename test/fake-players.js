// 測試用：模擬多支手機加入並自動玩（跑步連打、足球搖桿 + 頭槌 + 衝刺）
// 用法：npm run fake -- <房號> [人數=6] [--chaos]
//   --chaos：隨機讓一些假人斷線，1～3 秒後用同一個 playerId 重新連回來（模擬手機沒訊號 / 切分頁）
const { io } = require('socket.io-client');
const cfg = require('../public/characters.json');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const chaos = process.argv.includes('--chaos');
const room = args[0];
const count = Number(args[1] || 6);
if (!room) { console.log('用法：npm run fake -- <房號> [人數] [--chaos]'); process.exit(1); }
const URL = 'http://localhost:' + (process.env.PORT || 3000);

function fakePlayer(i) {
  const playerId = 'fake' + i;
  let socket = null;
  let state = { phase: 'lobby' };       // 大廳廣播的階段
  let status = null;                    // 主畫面傳給我的個人狀態
  let side = 'R';                       // 跑步：下一下按哪邊
  // 足球：漫步方向、頭槌蓄力
  let angle = Math.random() * Math.PI * 2;
  let neckUntil = 0, nextNeckAt = Date.now() + 1000 + Math.random() * 2000, nextDashAt = Date.now() + 2000 + Math.random() * 3000;
  let dashUntil = 0;
  let timers = [];

  function connect() {
    socket = io(URL, { forceNew: true });
    socket.on('connect', () => {
      socket.emit('player:join', { room, playerId, name: '假人' + i }, (res) => { if (!res || !res.ok) console.log(playerId, 'join 失敗', res); });
      // 角色可重複，顏色每人不同
      socket.emit('player:pick', { charId: cfg.characters[i % cfg.characters.length].id, color: cfg.colors[i % cfg.colors.length].hex });
    });
    socket.on('game:state', (s) => { state = s; });
    socket.on('player:status', (s) => {
      status = s;
      if (s.overallRank) console.log(playerId, '總名次', s.overallRank, s.finishTime);
    });
  }
  connect();

  // 跑步：每 60~140ms 按一下，只在輪到自己且比賽中時按（模擬按鈕鎖定），左右交替
  timers.push(setInterval(() => {
    if (!socket || !socket.connected) return;
    if (state.game === 'race' || state.game == null) {
      if (state.phase === 'racing' && status && status.role === 'racer' && status.heat === state.heat && !status.finished) {
        side = side === 'L' ? 'R' : 'L';
        socket.emit('tap', { side });
      }
    }
  }, 60 + i * 15));

  // 足球：每 100ms 送一次整組輸入（像真的手機一樣有保活）
  timers.push(setInterval(() => {
    if (!socket || !socket.connected || state.game !== 'soccer') return;
    if (!['countdown', 'playing', 'goal'].includes(state.phase) || !status || status.role !== 'player') return;
    const now = Date.now();
    angle += (Math.random() - 0.5) * 0.9;                       // 慢慢轉彎
    if (now > nextNeckAt) { neckUntil = now + 100 + Math.random() * 900; nextNeckAt = neckUntil + 800 + Math.random() * 2500; }
    if (now > nextDashAt) { dashUntil = now + 120; nextDashAt = now + 1500 + Math.random() * 3000; }
    socket.emit('input', {
      mx: Math.cos(angle) * 0.9, my: Math.sin(angle) * 0.9,
      neck: now < neckUntil, dash: now < dashUntil,
    });
  }, 100));

  // 混亂模式：隨機斷線，過一下用同一個身分重連
  if (chaos) {
    const flap = () => {
      timers.push(setTimeout(() => {
        if (Math.random() < 0.5 && socket) {
          console.log(playerId, '斷線');
          socket.disconnect();
          timers.push(setTimeout(() => { console.log(playerId, '重連'); connect(); flap(); }, 1000 + Math.random() * 2000));
        } else flap();
      }, 3000 + Math.random() * 5000));
    };
    flap();
  }
}

for (let i = 1; i <= count; i++) fakePlayer(i);
