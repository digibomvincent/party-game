// AI 玩家：在主畫面（host）裡跑的假玩家，大廳按「＋AI」加入。
// 它們不是真的手機連線，而是每隔一小段時間用和手機相同格式的輸入呼叫目前遊戲的 onInput()：
//   跑步：交替點左右（偶爾連按、同時按而跌倒）；足球：追球、對準球門頭槌、其他人防守；陀螺大戰：撞最容易掉出去的人，快掉出去時回中間。
const AI = (() => {
  const NAMES = ['阿財', '小美', '大雄', '胖虎', '靜香', '技安', '小夫', '哆啦', '路飛', '索隆', '娜美', '喬巴'];
  const MAX_PLAYERS = 12;
  let seq = 0;

  const isAI = (p) => !!p.ai;
  const list = () => [...Hub.players.values()].filter(isAI);

  function add() {
    if (Hub.phase !== 'lobby' || Hub.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...Hub.players.values()].map((p) => p.color));
    const color = Hub.colors.find((c) => !used.has(c));
    if (!color) return null;
    const id = 'ai-' + (++seq) + '-' + Math.random().toString(36).slice(2, 6);
    const taken = new Set([...Hub.players.values()].map((p) => p.name));
    const name = 'AI·' + (NAMES.find((n) => !taken.has('AI·' + n)) || ('機器人' + seq));
    const ch = Hub.characters[Math.floor(Math.random() * Hub.characters.length)];
    const p = { id, name, online: true, charId: ch.id, color, photo: '', ai: { skill: 0.75 + Math.random() * 0.35, side: 'L', nextTap: 0, neckUntil: 0, nextNeck: 0, ramAt: 0, dashAt: 0, pulse: false } };
    Hub.players.set(id, p);
    Hub.broadcastState();
    renderLobby();
    return p;
  }
  function remove() {
    if (Hub.phase !== 'lobby') return;
    const a = list().pop();
    if (!a) return;
    Hub.players.delete(a.id);
    Hub.broadcastState();
    renderLobby();
  }

  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };
  const jitter = (a, amt) => { const t = Math.atan2(a.y, a.x) + (Math.random() - 0.5) * amt; return { x: Math.cos(t), y: Math.sin(t) }; };

  // ---------- 跑步 ----------
  function raceTick(p, now) {
    const g = Hub.currentGame, st = g.statusOf(p), a = p.ai;
    if (Hub.phase !== 'racing' || !st || st.role !== 'racer' || st.heat !== g.stateExtra().heat || st.finished) return;
    if (now < a.nextTap) return;
    a.nextTap = now + (150 + Math.random() * 90) / a.skill;                        // 差不多一秒 4~6 下
    let side = a.side === 'L' ? 'R' : 'L';
    const r = Math.random();
    if (r < 0.03) side = a.side;                                                   // 手滑連按同一邊
    else if (r < 0.04) side = 'both';                                              // 兩邊一起按而跌倒
    a.side = side === 'both' ? a.side : side;
    g.onInput(p.id, { side });
  }

  // ---------- 足球 ----------
  function soccerTick(p, now, S) {
    const g = Hub.currentGame, a = p.ai;
    const send = (o) => g.onInput(p.id, { mx: 0, my: 0, dash: false, neck: false, ax: 0, ay: 0, ...o });
    if (S.phase !== 'playing') { send({}); return; }
    const me = S.field.find((f) => f.id === p.id);
    if (!me) return;
    const dir = me.team === 0 ? 1 : -1;
    const goal = { x: me.team === 0 ? 1208 : 72, y: 400 }, own = { x: me.team === 0 ? 72 : 1208, y: 400 };
    const ball = S.ball;
    const mates = S.field.filter((f) => f.team === me.team);
    const order = mates.map((f) => ({ id: f.id, d: Math.hypot(f.x - ball.x, f.y - ball.y) })).sort((x, y) => x.d - y.d);
    const rank = order.findIndex((o) => o.id === p.id);
    const chasers = mates.length >= 4 ? 2 : 1;
    const dBall = Math.hypot(ball.x - me.x, ball.y - me.y);

    if (rank < chasers) {                                                          // 追球、頭槌
      const toGoal = unit(goal.x - ball.x, goal.y - ball.y);
      const behind = { x: ball.x - toGoal.x * 75, y: ball.y - toGoal.y * 75 };    // 球「後面」（相對球門）的位置
      const lined = unit(ball.x - me.x, ball.y - me.y);
      const aligned = lined.x * toGoal.x + lined.y * toGoal.y > 0.55;
      let move;
      if (dBall < 100 && aligned) move = lined; else move = unit(behind.x - me.x, behind.y - me.y);
      move = jitter(move, 0.25 / a.skill);
      let neck = now < a.neckUntil, ax = 0, ay = 0;
      if (!neck && dBall < 105 && aligned && now > a.nextNeck && Math.random() < 0.5 * a.skill) {
        a.neckUntil = now + 220 + Math.random() * 300; a.nextNeck = a.neckUntil + 600 + Math.random() * 500; neck = true;
      }
      if (neck) { const aim = jitter(toGoal, 0.12 / a.skill); ax = aim.x * 0.95; ay = aim.y * 0.95; }
      let dash = false;
      if (dBall > 280 && now > a.dashAt && Math.random() < 0.3) { dash = true; a.dashAt = now + 2200 + Math.random() * 2000; }
      send({ mx: move.x * 0.95, my: move.y * 0.95, neck, ax, ay, dash });
      return;
    }
    // 防守：站在球和自己球門之間，離自己球門一段距離
    const slot = rank - chasers;                                                    // 第幾個防守的人，站得錯開
    const ballOwnHalf = (ball.x - 640) * dir < 0;
    const k = ballOwnHalf ? 0.5 : 0.3;
    const tx = own.x + (ball.x - own.x) * k + dir * 40 * slot, ty = 400 + (ball.y - 400) * 0.6 + (slot % 2 ? 90 : -90) * (slot ? 1 : 0);
    const dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
    const m = Math.min(1, d / 70);
    // 球快飛到面前、而且在附近 → 順手頭槌一下把球打走（往對方球門）
    let neck = now < a.neckUntil, ax = 0, ay = 0;
    if (!neck && dBall < 90 && now > a.nextNeck) { a.neckUntil = now + 200; a.nextNeck = now + 1200; neck = true; }
    if (neck) { const t = unit(goal.x - ball.x, goal.y - ball.y); ax = t.x * 0.9; ay = t.y * 0.9; }
    send({ mx: d > 8 ? (dx / d) * m : 0, my: d > 8 ? (dy / d) * m : 0, neck, ax, ay });
  }

  // ---------- 陀螺大戰 ----------
  function spinnerTick(p, now, S) {
    const g = Hub.currentGame, a = p.ai;
    const send = (o) => g.onInput(p.id, { mx: 0, my: 0, dash: false, ...o });
    if (Hub.phase === 'prepare') { const st = g.statusOf(p); if (st && st.role === 'player' && !st.ready) send({ ready: true, mode: 'stick' }); return; }
    if (Hub.phase !== 'playing') { send({}); return; }
    const me = S.discs.find((d) => d.id === p.id);
    if (!me || !me.alive || me.falling) { send({}); return; }
    const R = S.arenaR, r = Math.hypot(me.x - 640, me.y - 390);
    const foes = S.discs.filter((d) => d.id !== p.id && d.alive && !d.falling);
    let want = null, dash = false;
    if (r > R * 0.7 || !foes.length) {
      want = unit(640 - me.x, 390 - me.y);                                          // 太靠邊 → 回中間（碗會幫忙把人拉回來）
    } else {
      // 挑最容易撞出去的：離我近、而且離中心遠
      let best = null, bs = Infinity;
      for (const f of foes) { const sc = Math.hypot(f.x - me.x, f.y - me.y) - 0.6 * Math.hypot(f.x - 640, f.y - 390); if (sc < bs) { bs = sc; best = f; } }
      const dx = best.x + best.vx * 0.15 - me.x, dy = best.y + best.vy * 0.15 - me.y, d = Math.hypot(dx, dy);
      want = jitter(unit(dx, dy), 0.5 / a.skill);
      if (d < 150 && r < R * 0.6 && now > a.ramAt && Math.random() < 0.35 * a.skill) { dash = true; a.ramAt = now + 2400 + Math.random() * 1500; }
    }
    send({ mx: want.x * 0.9, my: want.y * 0.9, dash });
  }

  // ---------- 主迴圈 ----------
  let last = 0;
  setInterval(() => {
    const ais = list();
    if (!ais.length || !Hub.currentGame) return;
    const now = Date.now(), id = Hub.currentGameId;
    const throttle = id === 'race' ? 0 : 60;                                       // 足球／陀螺最多每 60ms 決定一次
    if (now - last < throttle) return;
    last = now;
    try {
      let S = null;
      if (id === 'soccer') S = Hub.games.soccer._state();
      else if (id === 'spinner') S = Hub.games.spinner._state();
      for (const p of ais) {
        if (id === 'race') raceTick(p, now);
        else if (id === 'soccer') soccerTick(p, now, S);
        else if (id === 'spinner') spinnerTick(p, now, S);
      }
    } catch (e) { console.error('AI error', e); }
  }, 40);

  return { add, remove, list, isAI };
})();
Hub.AI = AI;
