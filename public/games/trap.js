// ============================================================
// games/trap.js － 「陷阱跑酷」：類似「超級雞馬」的放陷阱跑酷（最多 6 人，固定 8 回合）
//   每回合三段：
//     1) 挑道具 trapPick：派對箱裡有（人數 + 2）個隨機道具，大家在手機上搶，先搶先贏
//     2) 放道具 trapPlace：用手機的方向鍵移動游標、旋轉、放下（道具會一直留在關卡上，越來越難）
//     3) 衝刺 trapRun：大家同時從起點跑向終點旗子（不限時；全部到終點或死掉才結束，主持人也可以手動結束）
//   計分（每回合）：到終點 +10、第一個到 +5、只有你到 +5、你放的陷阱殺了別人每個 +3；
//                   全部人都到（太簡單）或沒人到（太難）→ 這回合沒人得分。8 回合後依總分排名。
//   階段 phase：trapPick → trapPlace → trapRun → trapScore → (下一回合 ...) → result
// ============================================================
const TrapGame = (() => {
  const { players, $, escapeHtml, setPhase, sendStatus, sendAllStatus } = Hub;

  // ---------- 規則 ----------
  const MAX_PLAYERS = 6;
  const ROUNDS = 8;
  const PICK_MS = 12000, PLACE_MS = 18000, SCORE_MS = 5000, RUN_END_DELAY = 1300;
  const PTS_FINISH = 10, PTS_FIRST = 5, PTS_SOLO = 5, PTS_KILL = 3;
  // ---------- 畫面與關卡格子 ----------
  const T = 32, COLS = 40, ROWS = 20, OY = 64;          // 一格 32 像素；關卡 40×20 格，從 y=64 開始（上面留給標題）
  const W = 1280, H = 720;
  // ---------- 手感 ----------
  const PW = 20, PH = 30;                                // 角色碰撞框（寬、高）
  const RUN = 240, ACC_GROUND = 2400, ACC_AIR = 1500, ACC_ICE = 380;
  const GRAV = 1900, JUMP_V = 680, JUMP_CUT = 260, MAX_FALL = 900;
  const COYOTE = 0.1, JUMP_BUF = 0.13;                   // 離開平台後還能跳的時間、落地前按跳也算的時間
  const WALL_SLIDE = 140, WJ_X = 300, WJ_V = 580, WJ_LOCK = 0.16;   // 貼牆滑落速度、蹬牆跳
  const SPRING_V = 980, SPRING_SIDE = 620;
  const ARROW_SPEED = 430, BOW_PERIOD = 2.0;
  const SAW_R = 22;
  const CHAR_SCALE = 0.4;
  const STEP = 1 / 60;
  const INPUT_TIMEOUT_MS = 600;

  // 道具：cells = 佔的格子（以 (0,0) 為原點，旋轉時一起轉）；dir = 有方向的道具預設朝向
  const ITEMS = {
    block:  { name: '木箱', icon: '📦', cells: [[0, 0]], solid: true },
    plank:  { name: '木板', icon: '🪵', cells: [[-1, 0], [0, 0], [1, 0]], solid: true },
    spikes: { name: '尖刺', icon: '🔺', cells: [[0, 0]], hazard: true, dir: [0, -1] },
    saw:    { name: '鋸片', icon: '⚙️', cells: [[0, 0]], saw: true },
    bow:    { name: '十字弓', icon: '🏹', cells: [[0, 0]], solid: true, bow: true, dir: [1, 0] },
    spring: { name: '彈簧', icon: '🟢', cells: [[0, 0]], solid: true, spring: true, dir: [0, -1] },
    bomb:   { name: '炸彈', icon: '💣', cells: [[0, 0]], bomb: true },
    ice:    { name: '冰塊', icon: '🧊', cells: [[0, 0], [1, 0]], solid: true, ice: true },
  };
  const BOX_WEIGHTS = { block: 3, plank: 3, spikes: 3, saw: 2, bow: 2, spring: 2, bomb: 2, ice: 2 };

  // 地圖：solid = 實心地形的矩形 [col, row, 寬, 高]；spawn = 出生的格子；flag = 終點旗子的格子；noBuild = 不能放道具的區域
  const MAPS = [
    { name: '斷崖', solid: [[0, 15, 8, 5], [11, 14, 4, 1], [18, 12, 4, 1], [25, 14, 3, 1], [31, 15, 9, 5]], spawnCol: 1, spawnRow: 14, flag: [36, 14] },
    { name: '階梯', solid: [[0, 15, 7, 5], [9, 13, 3, 1], [14, 11, 3, 1], [19, 9, 3, 1], [24, 11, 3, 1], [29, 13, 3, 1], [33, 15, 7, 5]], spawnCol: 1, spawnRow: 14, flag: [37, 14] },
    { name: '大坑', solid: [[0, 15, 17, 5], [12, 13, 1, 2], [21, 15, 19, 5], [27, 13, 1, 2]], spawnCol: 1, spawnRow: 14, flag: [37, 14] },
  ];

  // ---------- 狀態 ----------
  const S = (p) => p.trap || (p.trap = { score: 0, gain: 0, kills: 0, roundKills: 0, item: null, placed: false, cx: 20, cy: 8, rot: 0,
    input: { mx: 0, my: 0, jump: false, at: 0 }, req: {}, ai: null });
  let participants = [], round = 0, map = null, terrain = null, items = [], itemSeq = 0, box = [];
  let runners = [], arrows = [], finishOrder = [], timers = [], deadline = 0, version = 0;
  let events = [];                               // 給畫面播的事件：{ type: 'die'|'finish'|'bomb'|'spring'|'place', x, y }
  let panelHtml = '';
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  // ---------- 格子工具 ----------
  const rotCell = ([x, y], r) => { for (let i = 0; i < r; i++) [x, y] = [-y, x]; return [x, y]; };
  const cellsOf = (type, cx, cy, r) => ITEMS[type].cells.map((c) => { const [dx, dy] = rotCell(c, r); return [cx + dx, cy + dy]; });
  const dirOf = (type, r) => (ITEMS[type].dir ? rotCell(ITEMS[type].dir, r) : [0, 0]);
  const inRect = (c, r, rc) => c >= rc[0] && c < rc[0] + rc[2] && r >= rc[1] && r < rc[1] + rc[3];
  function buildTerrain() {
    terrain = Array.from({ length: COLS }, () => new Array(ROWS).fill(false));
    for (const [c0, r0, w, h] of map.solid) for (let c = c0; c < c0 + w; c++) for (let r = r0; r < r0 + h; r++) if (c < COLS && r < ROWS) terrain[c][r] = true;
  }
  const noBuild = () => [[0, map.spawnRow - 5, 8, 6], [map.flag[0] - 2, map.flag[1] - 4, 5, 5]];      // 起點和終點附近不能放
  const itemAt = (c, r) => items.find((it) => it.cells.some(([x, y]) => x === c && y === r));
  function solidAt(c, r) {
    if (c < 0 || c >= COLS) return { wall: true };              // 左右兩邊是牆
    if (r < 0 || r >= ROWS) return null;                         // 上下是空的（掉下去就死）
    if (terrain[c][r]) return { terrain: true };
    const it = itemAt(c, r);
    return it && ITEMS[it.type].solid ? it : null;
  }
  function canPlace(type, cx, cy, r) {
    if (ITEMS[type].bomb) return cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS;
    return cellsOf(type, cx, cy, r).every(([c, rr]) => c >= 0 && c < COLS && rr >= 0 && rr < ROWS && !terrain[c][rr] && !itemAt(c, rr) &&
      !noBuild().some((rc) => inRect(c, rr, rc)));
  }
  function placeItem(p) {
    const s = S(p);
    if (!s.item || s.placed || !canPlace(s.item, s.cx, s.cy, s.rot)) return false;
    s.placed = true;
    if (ITEMS[s.item].bomb) {                                     // 炸彈：炸掉周圍 3×3 格內的道具（地形炸不掉）
      items = items.filter((it) => !it.cells.some(([c, r]) => Math.abs(c - s.cx) <= 1 && Math.abs(r - s.cy) <= 1));
      events.push({ type: 'bomb', x: s.cx * T + T / 2, y: OY + s.cy * T + T / 2 });
    } else {
      items.push({ id: ++itemSeq, type: s.item, owner: p.id, cx: s.cx, cy: s.cy, r: s.rot, cells: cellsOf(s.item, s.cx, s.cy, s.rot), dir: dirOf(s.item, s.rot), t: Math.random() * BOW_PERIOD });
      events.push({ type: 'place', x: s.cx * T + T / 2, y: OY + s.cy * T + T / 2 });
    }
    sendStatus(p);
    if (participants.every((x) => !x.online || !S(x).item || S(x).placed)) { clearTimers(); later(beginRun, 700); }
    return true;
  }

  // ============================================================
  // 回合流程
  // ============================================================
  function start() {
    for (const [id, p] of players) if (!p.online) players.delete(id);
    const list = [...players.values()].filter((p) => p.color).slice(0, MAX_PLAYERS);
    if (!list.length) return;
    clearTimers();
    players.forEach((p) => { delete p.trap; });
    participants = list; participants.forEach((p) => S(p));
    map = MAPS[Math.floor(Math.random() * MAPS.length)];
    buildTerrain(); items = []; round = 0; version++;
    Hub.game.scene.stop('trap'); Hub.game.scene.start('trap');
    $('trapPanel').classList.add('hidden');
    nextRound();
  }
  function stop() {
    clearTimers();
    participants = []; runners = []; arrows = []; items = [];
    players.forEach((p) => { delete p.trap; });
    $('trapPanel').classList.add('hidden'); $('trapEndBtn').classList.add('hidden');
    Hub.game.scene.stop('trap');
  }

  function nextRound() {
    clearTimers();
    round++;
    if (round > ROUNDS) { showFinal(); return; }
    // 派對箱：人數 + 2 個隨機道具（照權重抽）
    const pool = Object.entries(BOX_WEIGHTS).flatMap(([k, w]) => new Array(w).fill(k));
    box = Array.from({ length: Math.min(8, participants.length + 2) }, () => ({ type: pool[Math.floor(Math.random() * pool.length)], by: null }));
    participants.forEach((p) => { const s = S(p); s.item = null; s.placed = false; s.gain = 0; s.roundKills = 0; s.cx = 20; s.cy = 7; s.rot = 0; });
    deadline = Date.now() + PICK_MS;
    renderPickPanel();
    setPhase('trapPick'); Sfx.play('beep');
    later(endPick, PICK_MS);
  }
  function pick(p, i) {
    const s = S(p), b = box[i];
    if (Hub.phase !== 'trapPick' || s.item || !b || b.by) return;
    b.by = p.id; s.item = b.type;
    Sfx.play('pick'); renderPickPanel(); sendAllStatus();
    if (participants.every((x) => !x.online || S(x).item)) { clearTimers(); later(endPick, 600); }
  }
  function endPick() {
    if (Hub.phase !== 'trapPick') return;
    clearTimers();
    for (const p of participants) {                               // 沒搶到的人：從剩下的隨機給一個
      if (S(p).item) continue;
      const left = box.filter((b) => !b.by);
      if (!left.length) continue;
      const b = left[Math.floor(Math.random() * left.length)]; b.by = p.id; S(p).item = b.type;
    }
    $('trapPanel').classList.add('hidden');
    deadline = Date.now() + PLACE_MS;
    setPhase('trapPlace'); Sfx.play('go');
    later(endPlace, PLACE_MS);
  }
  function endPlace() {                                           // 時間到還沒放的人：這回合的道具作廢
    if (Hub.phase !== 'trapPlace') return;
    beginRun();
  }

  function beginRun() {
    clearTimers();
    if (Hub.phase !== 'trapPlace') return;
    arrows = []; finishOrder = [];
    runners = participants.map((p, i) => ({ p, x: (map.spawnCol + 0.5 + i * 0.95) * T - PW / 2, y: OY + (map.spawnRow + 1) * T - PH, vx: 0, vy: 0,
      onGround: false, coyote: 0, jumpBuf: 0, wall: 0, lock: 0, face: 1, state: p.online ? 'run' : 'dead', onIce: false, killer: null }));
    participants.forEach((p) => { S(p).req = {}; });
    setPhase('trapRun'); Sfx.play('go');
    $('trapEndBtn').classList.remove('hidden');
  }
  function checkRunOver() {
    if (Hub.phase !== 'trapRun' || runners.some((r) => r.state === 'run')) return;
    if (checkRunOver.pending) return;
    checkRunOver.pending = true;
    later(() => { checkRunOver.pending = false; endRun(); }, RUN_END_DELAY);
  }
  function endRun() {
    if (Hub.phase !== 'trapRun') return;
    clearTimers(); $('trapEndBtn').classList.add('hidden');
    for (const r of runners) if (r.state === 'run') r.state = 'dead';            // 主持人手動結束：還在跑的算沒到
    const n = participants.filter((p) => p.online).length;
    const done = finishOrder.length;
    const scoring = n === 1 ? done > 0 : done > 0 && done < n;                   // 全部到（太簡單）或沒人到（太難）→ 這回合沒人得分
    for (const p of participants) {
      const s = S(p); s.gain = 0;
      if (!scoring) continue;
      const k = finishOrder.indexOf(p.id);
      if (k >= 0) s.gain += PTS_FINISH + (k === 0 ? PTS_FIRST : 0) + (done === 1 && n > 1 ? PTS_SOLO : 0);
      s.gain += s.roundKills * PTS_KILL;
      s.score += s.gain; s.kills += s.roundKills;
    }
    renderScorePanel(scoring ? '' : done === 0 ? '沒有人到終點：太難了，這回合沒人得分！' : '全部人都到了：太簡單，這回合沒人得分！');
    setPhase('trapScore');
    later(nextRound, SCORE_MS);
  }
  function showFinal() {
    clearTimers();
    const rows = [...participants].sort((a, b) => S(b).score - S(a).score);
    const medal = ['🥇', '🥈', '🥉'];
    panelHtml = `<h1>🚩 陷阱跑酷　最終排名</h1><ol class="rank${rows.length > 6 ? ' many' : ''}">` +
      rows.map((p, i) => `<li><span>${medal[i] || i + 1 + '.'} ${escapeHtml(p.name)}</span><span>${S(p).score} 分　<small style="color:#9fb3c8">殺 ${S(p).kills}</small></span></li>`).join('') +
      `</ol><div style="display:flex;gap:20px;justify-content:center"><button id="trapAgainBtn">再來一場</button><button id="trapLobbyBtn" style="background:#3b82f6;color:#fff">回遊戲大廳</button></div>`;
    showPanel();
    $('trapAgainBtn').onclick = start; $('trapLobbyBtn').onclick = () => Hub.backToLobby();
    setPhase('result');
    Hub.Score.submit({ game: 'trap', title: '陷阱跑酷', rows: rows.map((p) => ({ p, rank: 1 + rows.filter((x) => S(x).score > S(p).score).length, bonus: S(p).kills * 2 })) });
  }

  // ---------- 主畫面上的面板（挑道具、計分、最終排名）----------
  function showPanel() { $('trapPanel').innerHTML = panelHtml; $('trapPanel').classList.remove('hidden'); }
  function renderPickPanel() {
    panelHtml = `<h1>🎁 第 ${round} / ${ROUNDS} 回合　搶道具！</h1><div class="tpBox">` + box.map((b) => {
      const who = b.by ? players.get(b.by) : null;
      return `<div class="tpItem${who ? ' taken' : ''}" style="${who ? `--c:${who.color}` : ''}"><span class="ic">${ITEMS[b.type].icon}</span><b>${ITEMS[b.type].name}</b><small>${who ? escapeHtml(who.name) : '　'}</small></div>`;
    }).join('') + `</div><div class="next-info">在手機上點一個道具，先搶先贏</div>`;
    showPanel();
  }
  function renderScorePanel(note) {
    const rows = [...participants].sort((a, b) => S(b).score - S(a).score);
    const top = Math.max(30, ...rows.map((p) => S(p).score));
    panelHtml = `<h1>第 ${round} / ${ROUNDS} 回合結果</h1>` + (note ? `<div class="next-info" style="color:#fde68a">${note}</div>` : '') +
      `<div class="tpBars">` + rows.map((p) => {
        const s = S(p), before = s.score - s.gain;
        return `<div class="tpBar"><span class="nm" style="color:${p.color}">${escapeHtml(p.name)}</span><span class="track"><i style="width:${before / top * 100}%;background:${p.color}"></i>` +
          `<i class="gain" style="width:${s.gain / top * 100}%"></i></span><span class="pt">${s.score}${s.gain ? ` <em>+${s.gain}</em>` : ''}</span></div>`;
      }).join('') + `</div>`;
    showPanel();
  }

  // ============================================================
  // 物理（衝刺階段，固定步長）
  // ============================================================
  function overlapRect(ax, ay, aw, ah, bx, by, bw, bh) { return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by; }
  // 角色碰撞框和格子：先動 x 再動 y，回傳這一步碰到的實心格（彈簧用）
  function moveAndCollide(r, dt) {
    const hits = [];
    r.x += r.vx * dt;
    let c0 = Math.floor(r.x / T), c1 = Math.floor((r.x + PW - 0.01) / T), r0 = Math.floor((r.y - OY) / T), r1 = Math.floor((r.y + PH - 0.01 - OY) / T);
    r.wall = 0;
    for (let c = c0; c <= c1; c++) for (let rr = r0; rr <= r1; rr++) {
      const s = solidAt(c, rr); if (!s) continue;
      if (r.vx > 0) { r.x = c * T - PW; r.vx = 0; r.wall = 1; hits.push({ s, nx: -1, ny: 0 }); }
      else if (r.vx < 0) { r.x = (c + 1) * T; r.vx = 0; r.wall = -1; hits.push({ s, nx: 1, ny: 0 }); }
    }
    // 貼牆檢查（沒有往牆移動時也要知道旁邊是不是牆，才能蹬牆跳）
    if (!r.wall) {
      r0 = Math.floor((r.y - OY) / T); r1 = Math.floor((r.y + PH - 0.01 - OY) / T);
      for (let rr = r0; rr <= r1; rr++) { if (solidAt(Math.floor((r.x + PW + 1) / T), rr)) r.wall = 1; if (solidAt(Math.floor((r.x - 1) / T), rr)) r.wall = -1; }
    }
    r.y += r.vy * dt;
    c0 = Math.floor(r.x / T); c1 = Math.floor((r.x + PW - 0.01) / T); r0 = Math.floor((r.y - OY) / T); r1 = Math.floor((r.y + PH - 0.01 - OY) / T);
    r.onGround = false; r.onIce = false;
    for (let c = c0; c <= c1; c++) for (let rr = r0; rr <= r1; rr++) {
      const s = solidAt(c, rr); if (!s) continue;
      if (r.vy > 0) { r.y = OY + rr * T - PH; r.vy = 0; r.onGround = true; if (s.type === 'ice') r.onIce = true; hits.push({ s, nx: 0, ny: -1 }); }
      else if (r.vy < 0) { r.y = OY + (rr + 1) * T; r.vy = 0; hits.push({ s, nx: 0, ny: 1 }); }
    }
    if (!r.onGround) {                                           // 站在格子上（速度 0）時也算著地
      const rr = Math.floor((r.y + PH + 1 - OY) / T);
      for (let c = c0; c <= c1; c++) { const s = solidAt(c, rr); if (s && r.vy >= 0) { r.onGround = true; if (s.type === 'ice') r.onIce = true; } }
    }
    return hits;
  }
  function kill(r, killerId) {
    if (r.state !== 'run') return;
    r.state = 'dead'; r.killer = killerId || null;
    events.push({ type: 'die', x: r.x + PW / 2, y: r.y + PH / 2, color: r.p.color });
    if (killerId && killerId !== r.p.id) { const k = players.get(killerId); if (k && k.trap) S(k).roundKills++; }
    sendStatus(r.p); checkRunOver();
  }
  function stepPhysics(dt) {
    const now = Date.now();
    // 十字弓射箭
    for (const it of items) {
      if (it.type !== 'bow') continue;
      it.t += dt;
      if (it.t >= BOW_PERIOD) { it.t -= BOW_PERIOD; arrows.push({ x: it.cx * T + T / 2 + it.dir[0] * 18, y: OY + it.cy * T + T / 2 + it.dir[1] * 18, vx: it.dir[0] * ARROW_SPEED, vy: it.dir[1] * ARROW_SPEED, owner: it.owner }); }
    }
    for (const a of arrows) {
      a.x += a.vx * dt; a.y += a.vy * dt;
      const c = Math.floor(a.x / T), rr = Math.floor((a.y - OY) / T);
      if (a.x < -20 || a.x > W + 20 || a.y < 0 || a.y > H + 20 || (rr >= 0 && rr < ROWS && c >= 0 && c < COLS && solidAt(c, rr))) a.dead = true;
    }
    arrows = arrows.filter((a) => !a.dead);
    const [fc, fr] = map.flag;
    for (const r of runners) {
      if (r.state !== 'run') continue;
      const s = S(r.p), inp = s.input, stale = now - inp.at > INPUT_TIMEOUT_MS;
      if (!r.p.online) { kill(r, null); continue; }
      const mx = stale ? 0 : Math.max(-1, Math.min(1, inp.mx)), holdJump = !stale && inp.jump;
      if (s.req.jump) { r.jumpBuf = JUMP_BUF; s.req.jump = false; }
      if (s.req.give) { s.req.give = false; kill(r, null); continue; }
      r.jumpBuf = Math.max(0, r.jumpBuf - dt); r.coyote = r.onGround ? COYOTE : Math.max(0, r.coyote - dt); r.lock = Math.max(0, r.lock - dt);
      // 左右
      if (r.lock <= 0) {
        const acc = r.onGround ? (r.onIce ? ACC_ICE : ACC_GROUND) : ACC_AIR, target = mx * RUN, dv = target - r.vx;
        r.vx += Math.sign(dv) * Math.min(Math.abs(dv), acc * dt);
      }
      if (mx) r.face = mx > 0 ? 1 : -1;
      // 跳：地上（含剛離開的一瞬間）→ 一般跳；貼牆在空中 → 蹬牆跳
      if (r.jumpBuf > 0 && (r.onGround || r.coyote > 0)) { r.vy = -JUMP_V; r.jumpBuf = 0; r.coyote = 0; r.onGround = false; events.push({ type: 'jump', id: r.p.id }); }
      else if (r.jumpBuf > 0 && r.wall && !r.onGround) { r.vy = -WJ_V; r.vx = -r.wall * WJ_X; r.lock = WJ_LOCK; r.jumpBuf = 0; r.face = -r.wall; events.push({ type: 'jump', id: r.p.id }); }
      if (!holdJump && r.vy < -JUMP_CUT) r.vy = -JUMP_CUT;      // 早放開 → 跳比較低
      r.vy = Math.min(MAX_FALL, r.vy + GRAV * dt);
      if (r.wall && !r.onGround && r.vy > WALL_SLIDE && mx === r.wall) r.vy = WALL_SLIDE;   // 往牆推 → 慢慢滑下來
      const hits = moveAndCollide(r, dt);
      // 彈簧：碰到彈簧朝外的那一面 → 彈出去
      for (const h of hits) {
        if (!h.s || h.s.type !== 'spring') continue;
        const [dx, dy] = h.s.dir;
        if (h.nx === dx && h.ny === dy) {
          if (dy) { r.vy = dy * SPRING_V; } else { r.vx = dx * SPRING_SIDE; r.vy = -SPRING_SIDE * 0.6; r.lock = 0.25; }
          r.onGround = false; events.push({ type: 'spring', x: h.s.cx * T + T / 2, y: OY + h.s.cy * T + T / 2 });
        }
      }
      // 危險：掉出畫面、尖刺、鋸片、箭
      if (r.y > OY + ROWS * T + 40) { kill(r, null); continue; }
      const cx0 = Math.floor(r.x / T) - 1, cx1 = Math.floor((r.x + PW) / T) + 1, ry0 = Math.floor((r.y - OY) / T) - 1, ry1 = Math.floor((r.y + PH - OY) / T) + 1;
      for (const it of items) {
        if (r.state !== 'run') break;
        const [ic, ir] = [it.cx, it.cy];
        if (ic < cx0 || ic > cx1 || ir < ry0 || ir > ry1) continue;
        if (it.type === 'spikes' && overlapRect(r.x, r.y, PW, PH, ic * T + 4, OY + ir * T + 4, T - 8, T - 8)) kill(r, it.owner);
        if (it.type === 'saw') {
          const sx = ic * T + T / 2, sy = OY + ir * T + T / 2;
          const nx = Math.max(r.x, Math.min(sx, r.x + PW)), ny = Math.max(r.y, Math.min(sy, r.y + PH));
          if (Math.hypot(nx - sx, ny - sy) < SAW_R) kill(r, it.owner);
        }
      }
      for (const a of arrows) if (r.state === 'run' && overlapRect(r.x, r.y, PW, PH, a.x - 7, a.y - 3, 14, 6)) { kill(r, a.owner); a.dead = true; }
      if (r.state !== 'run') continue;
      // 終點旗子
      if (overlapRect(r.x, r.y, PW, PH, fc * T, OY + (fr - 2) * T, T, T * 3)) {
        r.state = 'done'; finishOrder.push(r.p.id);
        events.push({ type: 'finish', x: r.x + PW / 2, y: r.y + PH / 2, first: finishOrder.length === 1 });
        sendStatus(r.p); checkRunOver();
      }
    }
  }

  // 放道具階段：方向鍵按住會一格一格移動游標（第一次立刻動，之後每 0.11 秒動一格）
  function stepCursors(dt) {
    for (const p of participants) {
      const s = S(p);
      if (!s.item || s.placed) continue;
      if (s.req.rot) { s.req.rot = false; s.rot = (s.rot + 1) % 4; sendStatus(p); }
      if (s.req.place) { s.req.place = false; placeItem(p); continue; }
      const inp = s.input, stale = Date.now() - inp.at > INPUT_TIMEOUT_MS;
      const mx = stale ? 0 : Math.round(inp.mx), my = stale ? 0 : Math.round(inp.my);
      if (!mx && !my) { s.repeat = 0; continue; }
      s.repeat = (s.repeat || 0) - dt;
      if (s.repeat <= 0) {
        s.cx = Math.max(0, Math.min(COLS - 1, s.cx + mx)); s.cy = Math.max(0, Math.min(ROWS - 1, s.cy + my));
        s.repeat = s.moved ? 0.11 : 0.25; s.moved = true;
      }
    }
  }

  // ============================================================
  // 畫面（Phaser）
  // ============================================================
  class TrapScene extends Phaser.Scene {
    create() {
      this.acc = 0; this.version = -1; this.itemSprites = new Map(); this.sprites = [];
      if (!this.textures.exists('dot')) {
        const dot = this.textures.createCanvas('dot', 8, 8); dot.getContext().fillStyle = '#fff'; dot.getContext().fillRect(0, 0, 8, 8); dot.refresh();
      }
      // 天空與遠山
      const sky = this.add.graphics();
      sky.fillGradientStyle(0x1e3a8a, 0x1e3a8a, 0x7dd3fc, 0x7dd3fc, 1).fillRect(0, 0, W, H);
      sky.fillStyle(0x334155, 0.55).fillTriangle(0, 520, 220, 300, 460, 520).fillTriangle(380, 520, 640, 260, 900, 520).fillTriangle(820, 520, 1080, 320, 1280, 520);
      this.terrainG = this.add.graphics();
      this.flagG = this.add.graphics();
      this.cursorG = this.add.graphics().setDepth(50);
      this.arrowG = this.add.graphics().setDepth(30);
      this.cursorLabels = [];
      const ts = { fontSize: '30px', color: '#fff', fontStyle: 'bold', stroke: '#000', strokeThickness: 6 };
      this.title = this.add.text(W / 2, 30, '', ts).setOrigin(0.5).setDepth(100);
      this.sub = this.add.text(W / 2, 62, '', { fontSize: '20px', color: '#fde68a', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(100);
      this.timer = this.add.text(W - 24, 30, '', ts).setOrigin(1, 0.5).setDepth(100);
      this.drawTerrain();
    }
    drawTerrain() {
      const g = this.terrainG.clear();
      for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
        if (!terrain[c][r]) continue;
        const x = c * T, y = OY + r * T, top = r === 0 || !terrain[c][r - 1];
        g.fillStyle(0x7c4a21).fillRect(x, y, T, T);
        g.fillStyle(0x6b3f1c).fillRect(x + 4, y + 12, 6, 4).fillRect(x + 18, y + 22, 8, 4);
        if (top) g.fillStyle(0x22c55e).fillRect(x, y, T, 9).fillStyle(0x16a34a).fillRect(x, y + 9, T, 3);
      }
      // 起點與終點旗子
      const [fc, fr] = map.flag, fx = fc * T + T / 2, fy = OY + (fr + 1) * T;
      this.flagG.clear().fillStyle(0xe2e8f0).fillRect(fx - 2, fy - 96, 5, 96).fillStyle(0xef4444).fillTriangle(fx + 3, fy - 94, fx + 46, fy - 80, fx + 3, fy - 66);
      this.flagG.fillStyle(0xffffff, 0.15).fillRect(0, OY + (map.spawnRow - 5) * T, 8 * T, 6 * T).fillRect((fc - 2) * T, OY + (fr - 4) * T, 5 * T, 5 * T);
    }
    // 一個道具的圖（畫在以格子中心為原點的 Graphics 上，方向用旋轉處理）
    drawItem(g, type, r, alpha) {
      const a = alpha == null ? 1 : alpha, h = T / 2;
      const cells = ITEMS[type].cells.map((c) => rotCell(c, r));
      if (type === 'block') { g.fillStyle(0xb45309, a).fillRect(-h, -h, T, T).lineStyle(3, 0x78350f, a).strokeRect(-h + 2, -h + 2, T - 4, T - 4).lineBetween(-h + 3, -h + 3, h - 3, h - 3).lineBetween(h - 3, -h + 3, -h + 3, h - 3); }
      else if (type === 'plank' || type === 'ice') {
        for (const [dx, dy] of cells) {
          const x = dx * T, y = dy * T;
          if (type === 'plank') g.fillStyle(0xd6a35c, a).fillRect(x - h, y - h + 6, T, T - 12).lineStyle(2, 0x92400e, a).strokeRect(x - h, y - h + 6, T, T - 12);
          else g.fillStyle(0xbae6fd, a * 0.9).fillRect(x - h, y - h, T, T).lineStyle(2, 0xffffff, a).strokeRect(x - h + 1, y - h + 1, T - 2, T - 2).lineStyle(2, 0xffffff, a * 0.7).lineBetween(x - 8, y - 8, x + 4, y - 2);
        }
      } else if (type === 'spikes') {
        g.fillStyle(0x64748b, a).fillRect(-h, h - 6, T, 6);
        for (let i = 0; i < 3; i++) g.fillStyle(0xe2e8f0, a).fillTriangle(-h + i * 11, h - 6, -h + i * 11 + 11, h - 6, -h + i * 11 + 5.5, -h + 2);
      } else if (type === 'saw') {
        g.fillStyle(0x94a3b8, a);
        for (let i = 0; i < 10; i++) { const t = (i / 10) * Math.PI * 2; g.fillTriangle(Math.cos(t) * 14, Math.sin(t) * 14, Math.cos(t + 0.35) * 14, Math.sin(t + 0.35) * 14, Math.cos(t + 0.17) * SAW_R, Math.sin(t + 0.17) * SAW_R); }
        g.fillStyle(0xcbd5e1, a).fillCircle(0, 0, 15).fillStyle(0x475569, a).fillCircle(0, 0, 5);
      } else if (type === 'bow') {
        g.fillStyle(0x92400e, a).fillRect(-h, -h, T, T).fillStyle(0x451a03, a).fillRect(-h + 4, -3, T - 8, 6).lineStyle(3, 0xfde68a, a).beginPath().arc(4, 0, 12, -1.2, 1.2).strokePath();
        g.fillStyle(0xe5e7eb, a).fillTriangle(h + 2, 0, h - 8, -6, h - 8, 6);
      } else if (type === 'spring') {
        g.fillStyle(0x475569, a).fillRect(-h, h - 6, T, 6).lineStyle(3, 0x22c55e, a);
        for (let i = 0; i < 3; i++) g.lineBetween(-10, h - 8 - i * 6, 10, h - 11 - i * 6);
        g.fillStyle(0x16a34a, a).fillRect(-h + 2, -h + 2, T - 4, 7);
      } else if (type === 'bomb') {
        g.fillStyle(0x111827, a).fillCircle(0, 3, 12).fillStyle(0xf97316, a).fillCircle(8, -11, 4).lineStyle(2, 0xf59e0b, a).lineBetween(4, -6, 8, -11);
      }
    }
    // 方向道具（尖刺、十字弓、彈簧）預設朝上或朝右，用整個 Graphics 旋轉
    itemAngle(type, r) { return ITEMS[type].dir ? (r * Math.PI) / 2 : 0; }
    syncItems() {
      const ids = new Set(items.map((i) => i.id));
      for (const [id, s] of this.itemSprites) if (!ids.has(id)) { s.destroy(); this.itemSprites.delete(id); }
      for (const it of items) {
        if (this.itemSprites.has(it.id)) continue;
        const g = this.add.graphics().setPosition(it.cx * T + T / 2, OY + it.cy * T + T / 2).setDepth(10);
        const multi = ITEMS[it.type].cells.length > 1;
        this.drawItem(g, it.type, multi ? it.r : 0); if (!multi) g.setRotation(this.itemAngle(it.type, it.r));
        this.itemSprites.set(it.id, g);
      }
    }
    rebuildPlayers() {
      this.sprites.forEach((s) => { s.c.destroy(); s.label.destroy(); });
      this.sprites = participants.map((p) => {
        const body = this.add.sprite(0, 0, CharRender.ensureBody(this, p.color), 'f0').setScale(CharRender.BODY_SCALE);
        const headY = (24 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE - CharRender.HEAD_SIZE / 2 + 4;
        const head = this.add.image(0, headY, p.photo ? 'head-' + p.id : 'char-' + p.charId).setDisplaySize(CharRender.HEAD_SIZE, CharRender.HEAD_SIZE);
        const c = this.add.container(0, 0, [body, head]).setScale(CHAR_SCALE).setDepth(20);
        const label = this.add.text(0, 0, p.name, { fontSize: '15px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(21);
        return { p, c, body, head, label, color: p.color };
      });
    }
    burst(x, y, life, cfg, n) { const em = this.add.particles(x, y, 'dot', { ...cfg, lifespan: life, quantity: n, emitting: false }).setDepth(60); em.explode(n); this.time.delayedCall(life + 200, () => em.destroy()); }

    update(time, delta) {
      if (this.version !== version) { this.version = version; this.drawTerrain(); this.rebuildPlayers(); }
      if (Hub.phase === 'trapRun') {
        this.acc = Math.min(this.acc + delta / 1000, STEP * 6);
        while (this.acc >= STEP && Hub.phase === 'trapRun') { stepPhysics(STEP); this.acc -= STEP; }
      } else this.acc = 0;
      if (Hub.phase === 'trapPlace') stepCursors(delta / 1000);
      this.syncItems();
      for (const [id, g] of this.itemSprites) { const it = items.find((x) => x.id === id); if (it && it.type === 'saw') g.rotation += delta / 120; }
      // 事件：特效與音效
      for (const e of events.splice(0)) {
        if (e.type === 'die') { Sfx.play('fall'); this.burst(e.x, e.y, 600, { speed: { min: 80, max: 260 }, scale: { start: 1.2, end: 0 }, tint: [Phaser.Display.Color.HexStringToColor(e.color).color, 0xffffff, 0xef4444] }, 22); }
        else if (e.type === 'finish') { Sfx.play('finish'); this.burst(e.x, e.y, 900, { speed: { min: 100, max: 300 }, angle: { min: 200, max: 340 }, gravityY: 500, scale: { start: 1, end: 0.3 }, tint: [0xfacc15, 0x22c55e, 0x3b82f6, 0xef4444] }, 26); }
        else if (e.type === 'bomb') { Sfx.play('ultFire'); this.cameras.main.shake(250, 0.01); this.burst(e.x, e.y, 600, { speed: { min: 120, max: 360 }, scale: { start: 1.6, end: 0 }, tint: [0xf97316, 0xfacc15, 0x111827] }, 30); }
        else if (e.type === 'spring') { Sfx.play('boost'); }
        else if (e.type === 'place') { Sfx.play('kick', { power: 0.3 }); this.burst(e.x, e.y, 300, { speed: { min: 40, max: 120 }, scale: { start: 0.8, end: 0 }, tint: [0xffffff, 0xd6a35c] }, 8); }
        else if (e.type === 'jump') { Sfx.play('step'); }
      }
      // 箭
      this.arrowG.clear();
      for (const a of arrows) { const ang = Math.atan2(a.vy, a.vx), cx = Math.cos(ang), sy = Math.sin(ang); this.arrowG.lineStyle(3, 0xfde68a).lineBetween(a.x - cx * 10, a.y - sy * 10, a.x + cx * 8, a.y + sy * 8).fillStyle(0xe5e7eb).fillTriangle(a.x + cx * 12, a.y + sy * 12, a.x + cx * 4 - sy * 5, a.y + sy * 4 + cx * 5, a.x + cx * 4 + sy * 5, a.y + sy * 4 - cx * 5); }
      // 角色
      const running = Hub.phase === 'trapRun';
      const footToBody = (92 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE * CHAR_SCALE;
      for (const s of this.sprites) {
        const r = runners.find((x) => x.p === s.p);
        const show = running && r && r.state === 'run';
        s.c.setVisible(show); s.label.setVisible(show);
        if (!show) continue;
        s.c.setPosition(r.x + PW / 2, r.y + PH - footToBody); s.label.setPosition(r.x + PW / 2, r.y - 26);
        s.body.setFlipX(r.face < 0); s.head.setFlipX(r.face < 0);
        const moving = Math.abs(r.vx) > 20 && r.onGround;
        if (moving) { if (!s.body.anims.isPlaying) s.body.play('run-' + s.color); }
        else if (s.body.anims.isPlaying) { s.body.anims.stop(); s.body.setFrame('f0'); }
        s.c.setAngle(r.onGround ? 0 : Phaser.Math.Clamp(r.vx / 40, -8, 8));
      }
      // 放道具階段：每個人的游標（半透明的道具 + 衣服顏色框 + 名字；放不下時變紅）
      const g = this.cursorG.clear();
      this.cursorLabels.forEach((t) => t.setVisible(false));
      if (Hub.phase === 'trapPlace') {
        participants.forEach((p, i) => {
          const st = S(p);
          if (!st.item || st.placed) return;
          const ok = canPlace(st.item, st.cx, st.cy, st.rot), col = Phaser.Display.Color.HexStringToColor(p.color).color;
          for (const [c, r] of cellsOf(st.item, st.cx, st.cy, st.rot)) g.fillStyle(ok ? col : 0xef4444, 0.35).fillRect(c * T, OY + r * T, T, T).lineStyle(3, ok ? col : 0xef4444, 0.95).strokeRect(c * T + 1, OY + r * T + 1, T - 2, T - 2);
          if (!this.cursorLabels[i]) this.cursorLabels[i] = this.add.text(0, 0, '', { fontSize: '15px', color: '#fff', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5, 1).setDepth(55);
          this.cursorLabels[i].setText(`${p.name} ${ITEMS[st.item].icon}`).setPosition(st.cx * T + T / 2, OY + st.cy * T - 4).setVisible(true);
        });
      }
      this.updatePreviews();
      // 標題、說明、倒數
      const sec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const ph = Hub.phase;
      this.title.setText(round ? `陷阱跑酷　第 ${Math.min(round, ROUNDS)} / ${ROUNDS} 回合　${map ? map.name : ''}` : '');
      this.sub.setText(ph === 'trapPick' ? '在手機上搶一個道具！' : ph === 'trapPlace' ? '用方向鍵移動、旋轉，放下你的陷阱（自己要過得去喔）' : ph === 'trapRun' ? `衝到終點旗子！已到 ${finishOrder.length} 人` : '');
      this.timer.setText(ph === 'trapPick' || ph === 'trapPlace' ? String(sec) : '');
    }
    // 游標上的半透明道具：每個玩家一個 Graphics，依道具與旋轉重畫
    updatePreviews() {
      this.previews = this.previews || new Map();
      const show = Hub.phase === 'trapPlace';
      for (const p of participants) {
        let pv = this.previews.get(p.id);
        const st = S(p), vis = show && st.item && !st.placed;
        if (!vis) { if (pv) pv.g.setVisible(false); continue; }
        if (!pv) { pv = { g: this.add.graphics().setDepth(51), key: '' }; this.previews.set(p.id, pv); }
        const key = st.item + st.rot;
        if (pv.key !== key) {
          pv.key = key; pv.g.clear();
          const multi = ITEMS[st.item].cells.length > 1;
          this.drawItem(pv.g, st.item, multi ? st.rot : 0, 0.75); pv.g.setRotation(multi ? 0 : this.itemAngle(st.item, st.rot));
        }
        pv.g.setVisible(true).setPosition(st.cx * T + T / 2, OY + st.cy * T + T / 2);
      }
    }
  }
  Hub.game.scene.add('trap', TrapScene, false);

  // ============================================================
  // 給大廳（host.js）呼叫的介面
  // ============================================================
  $('trapEndBtn').onclick = () => { if (Hub.phase === 'trapRun') endRun(); };
  return {
    start, stop,
    // 手機：{ mx, my, jump（按住）, rot / place / give（按下的瞬間）, pick（搶第幾個道具） }
    onInput(playerId, data) {
      const p = players.get(playerId);
      if (!p || !p.trap || typeof data.mx !== 'number') return;
      const s = S(p), prev = s.input;
      if (Number.isInteger(data.pick) && data.pick >= 0) pick(p, data.pick);
      if (data.jump && !prev.jump) s.req.jump = true;
      if (data.rot && !prev.rot) s.req.rot = true;
      if (data.place && !prev.place) s.req.place = true;
      if (data.give && !prev.give) s.req.give = true;
      s.input = { mx: data.mx, my: data.my || 0, jump: !!data.jump, rot: !!data.rot, place: !!data.place, give: !!data.give, at: Date.now() };
    },
    onPlayerLeft() {
      if (Hub.phase === 'trapRun') { for (const r of runners) if (!r.p.online && r.state === 'run') kill(r, null); }
      if (Hub.phase === 'trapPick' && participants.every((x) => !x.online || S(x).item)) { clearTimers(); later(endPick, 600); }
      if (Hub.phase === 'trapPlace' && participants.every((x) => !x.online || !S(x).item || S(x).placed)) { clearTimers(); later(beginRun, 700); }
    },
    onPlayerJoin() {},
    onPhase(phase) {
      if (phase !== 'trapPick' && phase !== 'trapScore' && phase !== 'result') $('trapPanel').classList.add('hidden');
      if (phase !== 'trapRun') $('trapEndBtn').classList.add('hidden');
    },
    statusOf(p) {
      if (!p.trap) return { role: 'late' };
      const s = S(p), r = runners.find((x) => x.p === p);
      const rows = [...participants].sort((a, b) => S(b).score - S(a).score);
      return {
        role: 'player', round, total: ROUNDS, score: s.score, gain: s.gain, rank: 1 + rows.filter((x) => S(x).score > s.score).length,
        box: box.map((b) => ({ icon: ITEMS[b.type].icon, name: ITEMS[b.type].name, taken: !!b.by, mine: b.by === p.id })),
        item: s.item ? { icon: ITEMS[s.item].icon, name: ITEMS[s.item].name } : null, placed: s.placed,
        run: Hub.phase === 'trapRun' && r ? r.state : null, finishRank: finishOrder.indexOf(p.id) + 1,
      };
    },
    stateExtra: () => ({ round }),
    lobbyInfo: (n) => n ? `已選好 ${n} 人，放陷阱跑酷（最多 ${MAX_PLAYERS} 人，${ROUNDS} 回合）` : '至少要有 1 人選好角色',
    // 測試／AI 用
    _state: () => ({ phase: Hub.phase, round, map: map && map.name, flag: map && map.flag, box: box.map((b) => ({ type: b.type, by: b.by })), items: items.map((i) => ({ type: i.type, cx: i.cx, cy: i.cy, owner: i.owner })),
      runners: runners.map((r) => ({ id: r.p.id, x: r.x, y: r.y, vx: r.vx, vy: r.vy, state: r.state, onGround: r.onGround })), finishOrder,
      players: participants.map((p) => ({ id: p.id, name: p.name, score: S(p).score, gain: S(p).gain, kills: S(p).kills, roundKills: S(p).roundKills, item: S(p).item, placed: S(p).placed, cx: S(p).cx, cy: S(p).cy })) }),
    _set: (o) => {
      if (o.runner) Object.assign(runners[o.runner.index], o.runner.set);
      if (o.cursor) { const p = players.get(o.cursor.id); Object.assign(S(p), o.cursor.set); }
      if (o.addItem) { const a = o.addItem; items.push({ id: ++itemSeq, type: a.type, owner: a.owner || null, cx: a.cx, cy: a.cy, r: a.r || 0, cells: cellsOf(a.type, a.cx, a.cy, a.r || 0), dir: dirOf(a.type, a.r || 0), t: 0 }); }
      if (o.clearItems) items = [];
      if (o.endRun) endRun();
      if (o.map != null) { map = MAPS[o.map]; buildTerrain(); items = []; version++; }
    },
    // AI：前方的狀況（給 ai.js 判斷要不要跳）
    _sense(id) {
      const r = runners.find((x) => x.p.id === id); if (!r) return null;
      const dir = r.face || 1, footRow = Math.floor((r.y + PH + 2 - OY) / T), midRow = Math.floor((r.y + PH / 2 - OY) / T);
      const aheadCol = Math.floor((dir > 0 ? r.x + PW + 6 : r.x - 6) / T), farCol = aheadCol + dir;
      const wallAhead = !!solidAt(aheadCol, midRow) || !!solidAt(aheadCol, midRow - 0);
      const gapAhead = !solidAt(aheadCol, footRow) && !solidAt(farCol, footRow) && !solidAt(aheadCol, footRow + 1);
      const danger = items.some((it) => (it.type === 'spikes' || it.type === 'saw') && Math.abs(it.cx - aheadCol) <= 1 && it.cy >= midRow - 1 && it.cy <= footRow);
      const [fc] = map.flag;
      return { x: r.x, onGround: r.onGround, wall: r.wall, wallAhead, gapAhead, danger, toFlag: Math.sign(fc * T - r.x), state: r.state };
    },
    _aiPlace(id) {                                                 // 隨機找一個中間區域放得下的位置（最多試 60 次）
      const p = players.get(id); const s = S(p);
      if (!s.item || s.placed) return;
      for (let k = 0; k < 60; k++) {
        const cx = 8 + Math.floor(Math.random() * 24), cy = 4 + Math.floor(Math.random() * 12), rot = Math.floor(Math.random() * 4);
        if (canPlace(s.item, cx, cy, rot)) { s.cx = cx; s.cy = cy; s.rot = rot; placeItem(p); return; }
      }
      s.placed = true; sendStatus(p);
    },
  };
})();
Hub.games.trap = TrapGame;
