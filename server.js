// ============================================================
// server.js － 只負責「房間管理」與「訊息轉送」，不含任何遊戲規則
// 遊戲邏輯（位置、名次、階段）全部在 public/host.js 計算
// ============================================================
const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

// ---------- 常數 ----------
const PORT = process.env.PORT || 3000;
const MAX_NAME_LENGTH = 10; // 暱稱最長字數
const MAX_PHOTO_LENGTH = 100000; // 大頭照 data URL 最大長度

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---------- 取得電腦的區域網路 IP（給手機掃 QR Code 用）----------
function getLanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP; // 猜錯時可手動指定
  const skip = /virtual|vmware|vethernet|wsl|docker|vbox|loopback|bluetooth/i; // 略過虛擬網卡
  let fallback = null;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!skip.test(name)) return a.address;
      if (!fallback) fallback = a.address;
    }
  }
  return fallback || 'localhost';
}

// 手機要連的網址前綴：部署在 Render 時用它給的網址，本機則用區網 IP
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://${getLanIp()}:${PORT}`;

// ---------- 房間資料 ----------
// rooms: 房號 -> { hostId, players: Map(playerId -> socketId), lastState }
const rooms = new Map();

// 產生不重複的 4 位數房號
function createRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  // ---------- host 建立房間 ----------
  socket.on('host:create', (cb) => {
    const code = createRoomCode();
    rooms.set(code, { hostId: socket.id, players: new Map(), lastState: null });
    socket.data = { role: 'host', room: code };
    socket.join(code);
    if (typeof cb === 'function') {
      cb({ room: code, controllerUrl: `${BASE_URL}/controller.html?room=${code}` });
    }
    console.log(`[房間 ${code}] 已建立`);
  });

  // ---------- host 廣播目前階段給所有手機 ----------
  socket.on('game:state', (state) => {
    if (socket.data?.role !== 'host') return;
    const room = rooms.get(socket.data.room);
    if (!room) return;
    room.lastState = state; // 記下來，之後加入的手機可立刻拿到
    socket.to(socket.data.room).emit('game:state', state);
  });

  // ---------- host 傳個人狀態給單一手機 ----------
  socket.on('player:status', ({ playerId, status } = {}) => {
    if (socket.data?.role !== 'host') return;
    const room = rooms.get(socket.data.room);
    const target = room?.players.get(playerId);
    if (target) io.to(target).emit('player:status', status);
  });

  // ---------- 手機加入 / 重新加入 ----------
  socket.on('player:join', (data, cb) => {
    const { room: code, playerId, name, photo } = data || {};
    const room = rooms.get(String(code));
    if (!room || !playerId) {
      if (typeof cb === 'function') cb({ ok: false, error: '找不到這個房號' });
      return;
    }
    const cleanName = String(name || '').trim().slice(0, MAX_NAME_LENGTH) || '無名氏';
    socket.data = { role: 'player', room: code, playerId };
    socket.join(code);
    room.players.set(playerId, socket.id);
    // 大頭照只接受小張 JPEG 的 data URL，其餘一律當作沒有
    const cleanPhoto = typeof photo === 'string' && photo.startsWith('data:image/jpeg;base64,') && photo.length < MAX_PHOTO_LENGTH ? photo : '';
    io.to(room.hostId).emit('player:join', { playerId, name: cleanName, photo: cleanPhoto });
    if (room.lastState) socket.emit('game:state', room.lastState);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // ---------- 手機按鍵 → 轉給 host ----------
  socket.on('tap', () => {
    if (socket.data?.role !== 'player') return;
    const room = rooms.get(socket.data.room);
    if (room) io.to(room.hostId).emit('tap', { playerId: socket.data.playerId });
  });

  // ---------- 斷線處理 ----------
  socket.on('disconnect', () => {
    const { role, room: code, playerId } = socket.data || {};
    const room = rooms.get(code);
    if (!room) return;

    if (role === 'host') {
      // host 離開：通知所有手機，房間作廢
      io.to(code).emit('room:closed');
      rooms.delete(code);
      console.log(`[房間 ${code}] host 離開，房間關閉`);
    } else if (role === 'player' && room.players.get(playerId) === socket.id) {
      // 只有「目前這條連線」斷了才算離線（避免重連時舊連線的斷線訊息誤判）
      room.players.delete(playerId);
      io.to(room.hostId).emit('player:left', { playerId });
    }
  });
});

server.listen(PORT, () => {
  console.log('======================================');
  console.log(' 朋友大頭賽跑 已啟動');
  console.log(` 主畫面（電腦/電視開）： ${BASE_URL}/host.html`);
  console.log(` 本機也可用：            http://localhost:${PORT}/host.html`);
  console.log('======================================');
});
