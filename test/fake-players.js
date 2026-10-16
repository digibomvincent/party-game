// 測試用：模擬多支手機加入並自動連打
// 用法：npm run fake -- <房號> [人數=6]
const { io } = require('socket.io-client');
const cfg = require('../public/characters.json');

const room = process.argv[2];
const count = Number(process.argv[3] || 6);
if (!room) { console.log('用法：npm run fake -- <房號> [人數]'); process.exit(1); }

for (let i = 1; i <= count; i++) {
  const socket = io('http://localhost:' + (process.env.PORT || 3000));
  const playerId = 'fake' + i;
  let state = { phase: 'lobby' };
  let status = null;
  let timer = null;
  let side = 'R';

  socket.on('connect', () => {
    socket.emit('player:join', { room, playerId, name: '假人' + i }, (res) => console.log(playerId, 'join', res));
    // 隨機角色 + 不重複的顏色
    socket.emit('player:pick', { charId: cfg.characters[i % cfg.characters.length].id, color: cfg.colors[i % cfg.colors.length].hex });
  });
  socket.on('game:state', (s) => { state = s; });
  socket.on('player:status', (s) => { status = s; });
  // 每 60~140ms 按一下，只在輪到自己且比賽中時按（模擬按鈕鎖定）
  timer = setInterval(() => {
    if (state.phase === 'racing' && status && status.role === 'racer' && status.heat === state.heat && !status.finished) {
      side = side === 'L' ? 'R' : 'L';   // 左右交替
      socket.emit('tap', { side });
    }
  }, 60 + i * 15);
  socket.on('player:status', (s) => {
    if (s.overallRank) console.log(playerId, '總名次', s.overallRank, s.finishTime);
  });
}
