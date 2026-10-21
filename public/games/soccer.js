// ============================================================
// games/soccer.js － 「足球」遊戲（M3：頭槌蓄力、衝刺、脖子伸縮；含分紅藍隊、進球計分、倒數、比賽時間、結算）
//   - 物理全部在 host 端算（固定 60Hz）；手機只送輸入 { mx, my, dash, neck }
//   - 角色沿用跑步的做法（CharRender：大頭 + 跑步身體）
//   - 頭槌：右手按住「頭槌」區域蓄力，往想打的方向滑動瞄準（球在附近時，球會往你滑的方向飛），放開就打出去；衝刺：往搖桿方向衝一小段（有冷卻）
//   - 瞄準輔助：滑的方向接近對方球門時，會自動修正成正對球門
//   - 還沒有：道具（M5）
//   - 和大廳（host.js）的溝通只透過 Hub 與下面回傳的介面
// 階段 phase：countdown（開球倒數）→ playing（比賽中）→ goal（進球慶祝）→ countdown … → result（結算）
// ============================================================
const SoccerGame = (() => {
  const { players, $, escapeHtml, setPhase } = Hub;

  // ---------- 球場（畫布 1280x720，俯視）----------
  const FIELD = { l: 100, r: 1180, t: 110, b: 690 };
  const CX = (FIELD.l + FIELD.r) / 2, CY = (FIELD.t + FIELD.b) / 2;
  const GOAL_H = 190, GOAL_D = 56;          // 球門開口高度、球門往場外凹進去的深度

  // ---------- 比賽規則 ----------
  const MAX_PLAYERS = 10;        // 最多上場人數（5v5），其餘的人先等下一場
  const MATCH_SECONDS = 180;     // 一場比賽 3 分鐘
  const OVERTIME_SECONDS = 60;   // 平手時的金球加時，最久 60 秒；還是沒進就算平手
  const FORFEIT_GRACE_MS = 15000; // 一整隊的人都斷線時，等多久還沒人回來就判該隊棄權
  const COUNTDOWN_SECONDS = 3;   // 開球前倒數
  const GOAL_PAUSE_MS = 2500;    // 進球後慶祝多久
  // 紅隊守左邊球門、攻右邊球門；藍隊相反
  const TEAMS = [
    { id: 'red',  name: '紅隊', color: 0xef4444, css: '#f87171' },
    { id: 'blue', name: '藍隊', color: 0x3b82f6, css: '#60a5fa' },
  ];

  // ---------- 手感數值（要調整就改這裡）----------
  const PLAYER_R = 20;           // 角色碰撞半徑（腳下）
  const BALL_R = 16;
  const MAX_SPEED = 300;         // 搖桿推到底的最高速度（像素/秒）
  const ACCEL = 12;              // 加速／減速的快慢（越大越靈敏）
  const BALL_DRAG = 0.8;         // 球的滾動阻力（每秒）
  const WALL_BOUNCE = 0.8;       // 球撞牆的彈性
  const HIT_BOUNCE = 0.6;        // 角色撞球的彈性
  const INPUT_TIMEOUT_MS = 600;  // 超過這麼久沒收到搖桿更新，就當作放開（防斷線、切分頁卡住）
  const CHAR_SCALE = 0.55;       // 角色縮放（10 人同場要小一點）

  // ---------- 頭槌與衝刺 ----------
  const CHARGE_SECONDS = 0.8;    // 按住頭槌多久蓄滿
  const CHARGE_MOVE = 0.55;      // 蓄力時移動速度變成這個比例
  const LUNGE_OUT = 0.10;        // 放開後脖子伸到最長要多久
  const LUNGE_HOLD = 0.06;       // 在最長處停留多久（這段時間頭才會碰球）
  const LUNGE_BACK = 0.22;       // 縮回來要多久
  const LUNGE_CD = 0.25;         // 縮回後多久才能再蓄力
  const LUNGE_MOVE = 0.4;        // 頭槌中移動速度變成這個比例
  const MIN_POWER = 0.2;         // 輕輕點一下頭槌的最小力道（0~1）
  const NECK_MIN = 45, NECK_MAX = 135;   // 脖子最短／最長伸出的距離（像素）
  const HEAD_R = 18;             // 頭的碰撞半徑
  const AIM_DEAD = 0.25;         // 右手滑動小於這個比例（0~1）就當作沒有瞄準（單純點一下）
  const AIM_POWER = 0.8;         // 滑得越遠，不用蓄力也能打得越用力：力道 = max(蓄力, 滑動距離 × 這個值)
  const GRAB_RANGE = 125;        // 球離角色這麼近（像素）時，頭會直接衝向球，球再往你瞄準的方向飛
  const AIM_ASSIST_DEG = 22;     // 瞄準輔助：瞄的方向和「球 → 對方球門中心」差在這個角度內，就自動修正成正對球門（0 = 關閉）
  const KICK_MIN = 420, KICK_MAX = 1150; // 頭槌把球打出去的速度（像素/秒），依力道內插
  const DASH_SECONDS = 0.18;     // 衝刺持續多久
  const DASH_SPEED = 680;        // 衝刺速度
  const DASH_COOLDOWN = 1.2;     // 衝刺冷卻（秒）
  const STEP = 1 / 60;           // 物理固定步長

  // ---------- 這個遊戲的狀態 ----------
  // 每位玩家的足球狀態放在 p.soccer（回大廳時清掉）：{ input, team, goals }
  const S = (p) => p.soccer || (p.soccer = { input: { mx: 0, my: 0, ax: 0, ay: 0, dash: false, neck: false, at: 0 }, team: 0, goals: 0 });
  let field = [];                // 場上的角色（見 newFielder）
  // 場上角色：位置速度 + 頭槌／衝刺狀態
  function newFielder(p, team) {
    return { p, x: CX, y: CY, vx: 0, vy: 0, face: 1, aim: { x: team === 0 ? 1 : -1, y: 0 },
      charging: false, charge: 0, aimIn: { x: 0, y: 0 }, lunge: null, lungeCd: 0, dashT: 0, dashCd: 0, dashDir: { x: 1, y: 0 }, prevNeck: false, prevDash: false };
  }
  function resetActions(f) {
    f.charging = false; f.charge = 0; f.aimIn = { x: 0, y: 0 }; f.lunge = null; f.lungeCd = 0; f.dashT = 0; f.dashCd = 0; f.prevNeck = false; f.prevDash = false;
  }
  let ball = { x: CX, y: CY, vx: 0, vy: 0, rot: 0, last: null };   // last = 最後碰到球的角色
  let version = 0;               // 場上角色換了就加一，場景據此重建
  let score = [0, 0];            // [紅, 藍]
  let remainingMs = 0;           // 比賽剩餘時間
  let overtime = false;
  let centerText = '';           // 畫面正中間的大字（倒數、進球、加時）
  let goalEvent = { n: 0, team: 0, scorerId: null };   // 進球事件（場景看到 n 變了就播慶祝）
  let kickEvent = { n: 0, x: 0, y: 0, power: 0 };       // 頭槌踢到球的事件（場景播特效）
  let dashEvent = { n: 0, id: null };                    // 衝刺事件
  let result = null;             // 結算：{ winner: 0 | 1 | -1(平手) }
  let notice = '';               // 畫面上方的小提示（例如「紅隊全員離線」）
  let forfeitTimer = null;
  let timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  // ============================================================
  // 開球站位
  // ============================================================
  // 紅隊站左半場、藍隊站右半場，同隊的人在場上平均排開（離中圈遠一點）
  function resetKickoff() {
    ball = { x: CX, y: CY, vx: 0, vy: 0, rot: 0, last: null };
    for (const team of [0, 1]) {
      const mates = field.filter((f) => S(f.p).team === team);
      mates.forEach((f, i) => {
        const span = FIELD.b - FIELD.t - 160;
        f.y = mates.length === 1 ? CY : FIELD.t + 80 + (span * i) / (mates.length - 1);
        f.x = CX + (team === 0 ? -1 : 1) * (200 + (i % 2) * 70);
        f.vx = 0; f.vy = 0;
        f.face = team === 0 ? 1 : -1;
        f.aim = { x: f.face, y: 0 };
        resetActions(f);
      });
    }
  }

  // ============================================================
  // 物理
  // ============================================================
  // 瞄準輔助：球要飛的方向 dir 如果接近「球 → 對方球門中心」，就修正成正對球門中心
  function assistDir(f, dir, from) {
    if (!AIM_ASSIST_DEG) return { dir, snapped: false };
    const team = S(f.p).team;
    const gx = team === 0 ? FIELD.r + GOAL_D / 2 : FIELD.l - GOAL_D / 2, gy = CY;       // 紅隊攻右邊球門、藍隊攻左邊
    const vx = gx - from.x, vy = gy - from.y, vl = Math.hypot(vx, vy) || 1, g = { x: vx / vl, y: vy / vl };
    const ang = Math.acos(Math.max(-1, Math.min(1, dir.x * g.x + dir.y * g.y))) * 180 / Math.PI;
    return ang <= AIM_ASSIST_DEG ? { dir: g, snapped: true } : { dir, snapped: false };
  }
  // 放開頭槌時，要往哪個方向打：右手有滑動就用滑動的方向，否則用目前的移動／面向方向（再套瞄準輔助）
  function kickDirection(f, dir) {
    const m = Math.hypot(f.aimIn.x, f.aimIn.y);
    const base = m > AIM_DEAD ? { x: f.aimIn.x / m, y: f.aimIn.y / m } : dir;
    return { ...assistDir(f, base, ball), aimed: m > AIM_DEAD, drag: Math.min(1, m) };
  }

  // 頭槌進行到哪：0（縮著）→ 1（伸到最長）→ 0；快速伸出、停一下、慢慢縮回
  function lungeExt(l) {
    if (l.t < LUNGE_OUT) { const u = l.t / LUNGE_OUT; return 1 - (1 - u) * (1 - u); }
    if (l.t < LUNGE_OUT + LUNGE_HOLD) return 1;
    const u = (l.t - LUNGE_OUT - LUNGE_HOLD) / LUNGE_BACK;
    return Math.max(0, 1 - u * u);
  }
  function stepPhysics(dt) {
    const now = Date.now();
    // 角色：搖桿方向 → 目標速度；頭槌（蓄力→放開→脖子伸出去）；衝刺
    for (const f of field) {
      if (!f.p.online) { f.vx = 0; f.vy = 0; resetActions(f); continue; }   // 離線的人變成不會動、不會擋路的幽靈
      const inp = S(f.p).input;
      const stale = now - inp.at > INPUT_TIMEOUT_MS;                  // 太久沒收到更新：當作全部放開（防斷線卡住）
      let mx = stale ? 0 : inp.mx, my = stale ? 0 : inp.my;
      const wantNeck = !stale && !!inp.neck, wantDash = !stale && !!inp.dash;
      if (wantNeck) f.aimIn = { x: inp.ax || 0, y: inp.ay || 0 };
      // 這一格之間「按下又放開」（太快、畫面剛好卡住）：補上一個按下的瞬間，下面才會看到蓄力與放開
      const quickTap = !stale && inp.neckDown && inp.neckUp && !wantNeck && !f.charging;
      inp.neckDown = inp.neckUp = false;                // 右手目前滑到哪（放開前最後一次的值就是要打的方向）
      const mag = Math.hypot(mx, my);
      if (mag > 1) { mx /= mag; my /= mag; }
      const hasDir = mag > 0.25;
      if (hasDir) f.aim = { x: mx / mag, y: my / mag };               // 記住最後瞄的方向（單位向量）
      const dir = f.aim;                                              // 頭槌／衝刺的方向：搖桿方向，沒推搖桿就用最後瞄的方向

      // 衝刺：按下的瞬間觸發，有冷卻
      f.dashCd = Math.max(0, f.dashCd - dt);
      if (wantDash && !f.prevDash && f.dashCd <= 0 && f.dashT <= 0) {
        f.dashT = DASH_SECONDS; f.dashCd = DASH_COOLDOWN; f.dashDir = { x: dir.x, y: dir.y };
        dashEvent = { n: dashEvent.n + 1, id: f.p.id };
      }
      f.prevDash = wantDash;

      // 頭槌：按下開始蓄力，放開就把脖子伸出去（蓄越久伸越長、打越遠）
      f.lungeCd = Math.max(0, f.lungeCd - dt);
      if ((wantNeck && !f.prevNeck || quickTap) && !f.lunge && f.lungeCd <= 0) { f.charging = true; f.charge = 0; if (quickTap) f.aimIn = inp.aimLast || { x: 0, y: 0 }; }
      if (f.charging) {
        if (stale) { f.charging = false; f.charge = 0; }               // 斷線：取消，不要突然撞出去
        else if (wantNeck) f.charge = Math.min(1, f.charge + dt / CHARGE_SECONDS);
        else {
          const k = kickDirection(f, dir);
          const power = MIN_POWER + (1 - MIN_POWER) * Math.max(f.charge, k.aimed ? AIM_POWER * k.drag : 0);
          // 球在附近：頭直接衝向球（一定打得到），但球會往瞄準的方向飛；球不在附近：頭往瞄準的方向伸出去
          const tx = ball.x - f.x, ty = ball.y - f.y, td = Math.hypot(tx, ty);
          const near = td <= GRAB_RANGE && td > 0;
          const headDir = near ? { x: tx / td, y: ty / td } : (k.aimed ? k.dir : { x: dir.x, y: dir.y });
          f.lunge = { t: 0, dir: headDir, kickDir: k.dir, reach: near ? Math.min(NECK_MAX, td) : null, power, hit: false };
          f.charging = false; f.charge = 0; f.aimIn = { x: 0, y: 0 };
        }
      }
      f.prevNeck = wantNeck;
      if (f.lunge) {
        f.lunge.t += dt;
        if (f.lunge.t >= LUNGE_OUT + LUNGE_HOLD + LUNGE_BACK) { f.lunge = null; f.lungeCd = LUNGE_CD; }
      }

      // 移動：衝刺時直接衝向衝刺方向；否則依搖桿，蓄力或頭槌時會變慢
      if (f.dashT > 0) {
        f.dashT -= dt;
        const kd = 1 - Math.exp(-40 * dt);
        f.vx += (f.dashDir.x * DASH_SPEED - f.vx) * kd;
        f.vy += (f.dashDir.y * DASH_SPEED - f.vy) * kd;
      } else {
        const mul = f.charging ? CHARGE_MOVE : f.lunge ? LUNGE_MOVE : 1;
        const k = 1 - Math.exp(-ACCEL * dt);
        f.vx += (mx * MAX_SPEED * mul - f.vx) * k;
        f.vy += (my * MAX_SPEED * mul - f.vy) * k;
      }
      f.x += f.vx * dt; f.y += f.vy * dt;
      // 不能出場外
      if (f.x < FIELD.l + PLAYER_R) { f.x = FIELD.l + PLAYER_R; f.vx = 0; }
      if (f.x > FIELD.r - PLAYER_R) { f.x = FIELD.r - PLAYER_R; f.vx = 0; }
      if (f.y < FIELD.t + PLAYER_R) { f.y = FIELD.t + PLAYER_R; f.vy = 0; }
      if (f.y > FIELD.b - PLAYER_R) { f.y = FIELD.b - PLAYER_R; f.vy = 0; }
      if (Math.abs(f.vx) > 20) f.face = f.vx > 0 ? 1 : -1;
    }
    // 角色之間：只擠開，不彈飛
    for (let i = 0; i < field.length; i++) {
      for (let j = i + 1; j < field.length; j++) {
        const a = field[i], b = field[j];
        if (!a.p.online || !b.p.online) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = PLAYER_R * 1.8;
        if (d > 0 && d < min) {
          const push = (min - d) / 2, nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        }
      }
    }
    // 球：滾動、阻力、撞牆
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    const drag = Math.exp(-BALL_DRAG * dt);
    ball.vx *= drag; ball.vy *= drag;
    ball.rot += (ball.vx * dt) / BALL_R;
    collideBallWalls();
    // 球和角色：角色把球推開（把角色當作很重的東西），並記下最後碰球的人
    for (const f of field) {
      if (!f.p.online) continue;
      const dx = ball.x - f.x, dy = ball.y - f.y, d = Math.hypot(dx, dy), min = PLAYER_R + BALL_R;
      if (d > 0 && d < min) {
        const nx = dx / d, ny = dy / d;
        ball.x = f.x + nx * min; ball.y = f.y + ny * min;           // 先分開，避免卡進去
        const relN = (ball.vx - f.vx) * nx + (ball.vy - f.vy) * ny;   // 球相對角色、沿著連線的速度
        if (relN < 0) { ball.vx -= (1 + HIT_BOUNCE) * relN * nx; ball.vy -= (1 + HIT_BOUNCE) * relN * ny; }
        ball.last = f;
      }
    }
    // 頭槌：脖子伸到最長的那一瞬間，頭碰到球就把球打出去（每次頭槌只會打一下）
    for (const f of field) {
      const l = f.lunge;
      if (!l || l.hit || l.t > LUNGE_OUT + LUNGE_HOLD) continue;
      const reach = l.reach != null ? l.reach : NECK_MIN + (NECK_MAX - NECK_MIN) * l.power, e = lungeExt(l);
      const hx = f.x + l.dir.x * reach * e, hy = f.y + l.dir.y * reach * e;
      const dx = ball.x - hx, dy = ball.y - hy, d = Math.hypot(dx, dy), min = HEAD_R + BALL_R;
      if (d < min) {
        const toBall = d > 0 ? { x: dx / d, y: dy / d } : l.dir;
        const speed = KICK_MIN + (KICK_MAX - KICK_MIN) * l.power;                    // 球一定照瞄準的方向飛（不是照頭撞到的角度）
        ball.vx = l.kickDir.x * speed + f.vx * 0.3; ball.vy = l.kickDir.y * speed + f.vy * 0.3;
        ball.x = hx + toBall.x * min; ball.y = hy + toBall.y * min;
        ball.last = f; l.hit = true;
        kickEvent = { n: kickEvent.n + 1, x: ball.x, y: ball.y, power: l.power };
      }
    }
    collideBallWalls();
    checkGoal();
    tickClock(dt);
  }

  // 球撞到場邊會彈回；球門開口的地方可以進到球門裡面
  function collideBallWalls() {
    const inMouth = Math.abs(ball.y - CY) <= GOAL_H / 2 - BALL_R;   // 球的高度在球門開口範圍內
    const xMin = (inMouth ? FIELD.l - GOAL_D : FIELD.l) + BALL_R;
    const xMax = (inMouth ? FIELD.r + GOAL_D : FIELD.r) - BALL_R;
    if (ball.x < xMin) { ball.x = xMin; ball.vx = Math.abs(ball.vx) * WALL_BOUNCE; }
    if (ball.x > xMax) { ball.x = xMax; ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE; }
    // 球在球門裡面時，上下被門柱擋住
    const inGoalX = ball.x < FIELD.l + BALL_R || ball.x > FIELD.r - BALL_R;
    const yMin = inGoalX ? CY - GOAL_H / 2 + BALL_R : FIELD.t + BALL_R;
    const yMax = inGoalX ? CY + GOAL_H / 2 - BALL_R : FIELD.b - BALL_R;
    if (ball.y < yMin) { ball.y = yMin; ball.vy = Math.abs(ball.vy) * WALL_BOUNCE; }
    if (ball.y > yMax) { ball.y = yMax; ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE; }
  }

  // ============================================================
  // 比賽流程
  // ============================================================
  // 球整顆越過球門線 → 進球（右邊球門算紅隊得分，左邊球門算藍隊得分）
  function checkGoal() {
    if (Hub.phase !== 'playing') return;
    if (ball.x - BALL_R > FIELD.r) onGoal(0);
    else if (ball.x + BALL_R < FIELD.l) onGoal(1);
  }

  function tickClock(dt) {
    if (Hub.phase !== 'playing') return;
    remainingMs -= dt * 1000;
    if (remainingMs > 0) return;
    remainingMs = 0;
    if (score[0] === score[1] && !overtime) {                // 平手 → 金球加時
      overtime = true;
      remainingMs = OVERTIME_SECONDS * 1000;
      centerText = '平手！金球決勝';
      later(() => { if (centerText === '平手！金球決勝') centerText = ''; }, 1800);
    } else {
      endMatch();                                            // 分出勝負，或加時賽仍平手
    }
  }

  function onGoal(team) {
    const f = ball.last;
    const own = f && S(f.p).team !== team;                    // 最後碰球的是對方 → 烏龍球
    score[team]++;
    if (f && !own) S(f.p).goals++;
    goalEvent = { n: goalEvent.n + 1, team, scorerId: f && !own ? f.p.id : null };
    centerText = `⚽ ${TEAMS[team].name}進球！` + (f ? `\n${own ? '烏龍球 ' : ''}${f.p.name}` : '');
    setPhase('goal');
    Sfx.play('goal');
    clearTimers();
    later(() => {
      centerText = '';
      if (overtime || remainingMs <= 0) endMatch();           // 金球，或哨音前的最後一球
      else beginCountdown();
    }, GOAL_PAUSE_MS);
  }

  // 開球前倒數：角色回到站位，3、2、1、GO
  function beginCountdown() {
    clearTimers();
    resetKickoff();
    setPhase('countdown');
    let count = COUNTDOWN_SECONDS;
    centerText = String(count); Sfx.play('beep');
    const tick = () => {
      count--;
      if (count > 0) { centerText = String(count); Sfx.play('beep'); later(tick, 1000); return; }
      centerText = 'GO!'; Sfx.play('go');
      setPhase('playing');
      later(() => { if (centerText === 'GO!') centerText = ''; }, 800);
    };
    later(tick, 1000);
  }

  // 一整隊的人都斷線：等一段時間（讓手機有機會重連），還沒人回來就判該隊棄權，另一隊獲勝；兩隊都沒人就直接回大廳
  function clearForfeit() { if (forfeitTimer) { clearTimeout(forfeitTimer); forfeitTimer = null; } notice = ''; }
  function checkTeams() {
    if (!['countdown', 'playing', 'goal'].includes(Hub.phase)) { clearForfeit(); return; }
    const dead = [0, 1].filter((t) => field.some((f) => S(f.p).team === t) && !field.some((f) => S(f.p).team === t && f.p.online));
    if (!dead.length) { clearForfeit(); return; }
    notice = `${dead.map((t) => TEAMS[t].name).join('、')}全員離線，${FORFEIT_GRACE_MS / 1000} 秒內沒人回來就判棄權`;
    if (forfeitTimer) return;
    forfeitTimer = setTimeout(() => {
      forfeitTimer = null; notice = '';
      const still = [0, 1].filter((t) => field.some((f) => S(f.p).team === t) && !field.some((f) => S(f.p).team === t && f.p.online));
      if (!still.length || !['countdown', 'playing', 'goal'].includes(Hub.phase)) return;
      if (still.length === 2) Hub.backToLobby();                  // 兩隊都沒人了
      else endMatch(1 - still[0]);                                // 沒人的那隊棄權
    }, FORFEIT_GRACE_MS);
  }

  function endMatch(forfeitWinner) {
    clearTimers(); clearForfeit();
    centerText = ''; Sfx.play('whistle');
    const forfeited = forfeitWinner === 0 || forfeitWinner === 1;
    const winner = forfeited ? forfeitWinner : score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
    result = { winner };
    // 結算面板：比分 + 每人進球數
    $('soccerTitle').textContent = winner < 0 ? '🤝 平手！' : `🏆 ${TEAMS[winner].name}獲勝！` + (forfeited ? '（對方全員離線）' : '');
    $('soccerScore').innerHTML = `<span style="color:${TEAMS[0].css}">紅隊 ${score[0]}</span> : <span style="color:${TEAMS[1].css}">${score[1]} 藍隊</span>`;
    const rows = field.map((f) => f.p).sort((a, b) => S(b).goals - S(a).goals);
    $('soccerList').classList.toggle('many', rows.length > 6);
    $('soccerList').innerHTML = rows.map((p) =>
      `<li><span style="color:${TEAMS[S(p).team].css}">● </span><span style="flex:1">${escapeHtml(p.name)}</span><span>${S(p).goals} 球</span></li>`).join('');
    setPhase('result');
  }

  // ============================================================
  // 畫面層（Phaser）：場地、球、角色（沿用跑步的身體與大頭）、比分與時間
  // ============================================================
  class SoccerScene extends Phaser.Scene {
    create() {
      this.acc = 0;
      this.sprites = [];
      this.version = -1;
      this.goalN = goalEvent.n; this.kickN = kickEvent.n; this.dashN = dashEvent.n;
      this.drawField();
      // 撒花用的小方塊貼圖（場景可能重複啟動，貼圖只建一次）
      if (!this.textures.exists('dot')) {
        const dot = this.textures.createCanvas('dot', 8, 8);
        dot.getContext().fillStyle = '#fff'; dot.getContext().fillRect(0, 0, 8, 8); dot.refresh();
      }
      // 球：陰影 + 白底黑邊 + 中間一塊深色
      this.ballShadow = this.add.ellipse(0, 0, BALL_R * 2, BALL_R * 0.9, 0x000000, 0.3).setDepth(1);
      const g = this.add.graphics();
      g.fillStyle(0xffffff).fillCircle(0, 0, BALL_R).lineStyle(3, 0x111111).strokeCircle(0, 0, BALL_R);
      g.fillStyle(0x222222).fillCircle(0, 0, 6).fillCircle(-10, -4, 3).fillCircle(9, 5, 3).fillCircle(2, -11, 3);
      this.ballSprite = this.add.container(CX, CY, [g]);
      // 上方：比分與時間
      const style = { fontSize: '44px', color: '#fff', fontStyle: 'bold', stroke: '#000', strokeThickness: 5 };
      this.redText = this.add.text(CX - 90, 56, '', { ...style, color: TEAMS[0].css }).setOrigin(1, 0.5);
      this.blueText = this.add.text(CX + 90, 56, '', { ...style, color: TEAMS[1].css }).setOrigin(0, 0.5);
      this.timeText = this.add.text(CX, 56, '', { ...style, fontSize: '40px' }).setOrigin(0.5);
      this.noticeText = this.add.text(CX, 92, '', { fontSize: '22px', color: '#fde68a', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(5000);
      // 正中間的大字（倒數、進球、加時）
      this.cdText = this.add.text(CX, CY - 20, '', { fontSize: '150px', color: '#fff', fontStyle: 'bold', align: 'center',
        stroke: '#000', strokeThickness: 12 }).setOrigin(0.5).setDepth(5000);
    }

    drawField() {
      const g = this.add.graphics();
      // 草地：直條紋
      const stripe = 90;
      for (let x = FIELD.l, i = 0; x < FIELD.r; x += stripe, i++) {
        g.fillStyle(i % 2 ? 0x2f8f4e : 0x37a05a).fillRect(x, FIELD.t, Math.min(stripe, FIELD.r - x), FIELD.b - FIELD.t);
      }
      // 球門（場外凹進去的區塊）+ 網子；左邊是紅隊的、右邊是藍隊的，用淡淡的隊色區分
      for (const side of [-1, 1]) {
        const gx = side < 0 ? FIELD.l - GOAL_D : FIELD.r;
        g.fillStyle(0x1b2a38).fillRect(gx, CY - GOAL_H / 2, GOAL_D, GOAL_H);
        g.fillStyle(TEAMS[side < 0 ? 0 : 1].color, 0.25).fillRect(gx, CY - GOAL_H / 2, GOAL_D, GOAL_H);
        g.lineStyle(1, 0x5b7186);
        for (let k = 0; k <= GOAL_D; k += 14) g.lineBetween(gx + k, CY - GOAL_H / 2, gx + k, CY + GOAL_H / 2);
        for (let k = 0; k <= GOAL_H; k += 14) g.lineBetween(gx, CY - GOAL_H / 2 + k, gx + GOAL_D, CY - GOAL_H / 2 + k);
      }
      // 白線：邊線、中線、中圈、禁區
      g.lineStyle(4, 0xffffff, 0.9);
      g.strokeRect(FIELD.l, FIELD.t, FIELD.r - FIELD.l, FIELD.b - FIELD.t);
      g.lineBetween(CX, FIELD.t, CX, FIELD.b);
      g.strokeCircle(CX, CY, 80);
      g.strokeRect(FIELD.l, CY - 150, 150, 300);
      g.strokeRect(FIELD.r - 150, CY - 150, 150, 300);
      // 球門框（白色粗線）
      g.lineStyle(8, 0xffffff);
      for (const side of [-1, 1]) {
        const gx = side < 0 ? FIELD.l - GOAL_D : FIELD.r + GOAL_D, inner = side < 0 ? FIELD.l : FIELD.r;
        g.lineBetween(inner, CY - GOAL_H / 2, gx, CY - GOAL_H / 2);
        g.lineBetween(inner, CY + GOAL_H / 2, gx, CY + GOAL_H / 2);
        g.lineBetween(gx, CY - GOAL_H / 2, gx, CY + GOAL_H / 2);
      }
      g.setDepth(0);
    }

    // 依場上角色重建：身體（跑步動畫）+ 大頭 + 名字 + 腳下的隊色環
    rebuild() {
      this.sprites.forEach((s) => { s.c.destroy(); s.label.destroy(); s.ring.destroy(); s.neck.destroy(); s.gauge.destroy(); s.aim.destroy(); });
      this.sprites = field.map((f) => {
        const p = f.p, team = TEAMS[S(p).team];
        const body = this.add.sprite(0, 0, CharRender.ensureBody(this, p.color), 'f0').setScale(CharRender.BODY_SCALE);
        const headY = (24 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE - CharRender.HEAD_SIZE / 2 + 4;
        const head = this.add.image(0, headY, p.photo ? 'head-' + p.id : 'char-' + p.charId)
          .setDisplaySize(CharRender.HEAD_SIZE, CharRender.HEAD_SIZE);
        const c = this.add.container(f.x, f.y, [body, head]).setScale(CHAR_SCALE);
        const label = this.add.text(f.x, f.y, p.name, { fontSize: '16px', color: '#fff', stroke: team.css, strokeThickness: 4 }).setOrigin(0.5);
        const ring = this.add.ellipse(f.x, f.y, PLAYER_R * 2.4, PLAYER_R * 1.1, 0x000000, 0.25).setStrokeStyle(4, team.color).setDepth(1);
        const neck = this.add.graphics();                            // 頭槌時伸長的脖子（畫在世界座標）
        const gauge = this.add.graphics().setDepth(3000);            // 蓄力條（腳下的圓弧）
        const aim = this.add.graphics().setDepth(3500);              // 瞄準箭頭（球會往哪裡飛）
        return { f, c, body, head, label, ring, neck, gauge, aim, headY, color: p.color };
      });
      this.version = version;
    }

    // 進球慶祝：得分的人轉頭，球門前撒彩帶
    celebrate() {
      const team = goalEvent.team;
      const x = team === 0 ? FIELD.r : FIELD.l;
      this.burst(x, CY, 1400, {
        speed: { min: 150, max: 380 }, angle: team === 0 ? { min: 120, max: 240 } : { min: -60, max: 60 }, gravityY: 300,
        scale: { start: 1.2, end: 0.4 }, rotate: { min: 0, max: 360 }, tint: [TEAMS[team].color, 0xffffff, 0xfacc15],
      }, 40);
      const s = this.sprites.find((x2) => x2.f.p.id === goalEvent.scorerId);
      if (s) this.tweens.add({ targets: s.head, angle: 360, duration: 700, ease: 'Cubic.easeOut', onComplete: () => { s.head.angle = 0; } });
    }

    // 噴一陣粒子，播完就把發射器銷毀（不然一場比賽下來會累積成百上千個物件）
    burst(x, y, lifespan, config, n) {
      const em = this.add.particles(x, y, 'dot', { ...config, lifespan, quantity: n, emitting: false }).setDepth(4000);
      em.explode(n);
      this.time.delayedCall(lifespan + 200, () => em.destroy());
    }

    // 頭槌踢到球：小爆炸；力道越大越多
    kickBurst() {
      const n = Math.round(6 + kickEvent.power * 14);
      this.burst(kickEvent.x, kickEvent.y, 350, {
        speed: { min: 80, max: 120 + kickEvent.power * 260 }, scale: { start: 0.9, end: 0 }, tint: [0xffffff, 0xfacc15, 0xf97316],
      }, n);
    }

    // 衝刺：在腳下留一串殘影
    dashTrail(s) {
      const g = this.add.ellipse(s.f.x, s.f.y + 2, PLAYER_R * 2, PLAYER_R * 0.9, 0xffffff, 0.45).setDepth(1);
      this.tweens.add({ targets: g, alpha: 0, scaleX: 0.4, duration: 260, onComplete: () => g.destroy() });
    }

    update(time, delta) {
      if (this.version !== version) this.rebuild();
      if (this.kickN !== kickEvent.n) { this.kickN = kickEvent.n; this.kickBurst(); Sfx.play('kick', { power: kickEvent.power }); }
      if (this.dashN !== dashEvent.n) { this.dashN = dashEvent.n; Sfx.play('dash'); }
      if (this.goalN !== goalEvent.n) { this.goalN = goalEvent.n; this.celebrate(); }
      // 固定步長物理（只有比賽中才動；畫面卡頓時最多補 6 步）
      if (Hub.phase === 'playing') {
        this.acc = Math.min(this.acc + delta / 1000, STEP * 6);
        while (this.acc >= STEP && Hub.phase === 'playing') { stepPhysics(STEP); this.acc -= STEP; }
      } else {
        this.acc = 0;
      }

      // 比分、時間、中間大字
      const sec = Math.ceil(Math.max(0, remainingMs) / 1000);
      this.redText.setText(`紅隊 ${score[0]}`);
      this.blueText.setText(`${score[1]} 藍隊`);
      this.timeText.setText(overtime ? `加時 ${sec}` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
      this.noticeText.setText(notice);
      this.cdText.setText(centerText).setFontSize(centerText.length > 4 ? 64 : 150);

      // 球
      this.ballSprite.setPosition(ball.x, ball.y).setRotation(ball.rot).setDepth(ball.y);
      this.ballShadow.setPosition(ball.x, ball.y + BALL_R * 0.8);
      // 角色
      const t = time / 1000;
      for (const s of this.sprites) {
        const f = s.f, speed = Math.hypot(f.vx, f.vy);
        const footToBody = (92 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE * CHAR_SCALE;   // 腳到身體中心的距離
        s.c.setPosition(f.x, f.y - footToBody).setDepth(f.y);
        s.ring.setPosition(f.x, f.y + 2);
        s.label.setPosition(f.x, f.y - footToBody - (CharRender.HEAD_SIZE * 0.5 - s.headY) * CHAR_SCALE - 16).setDepth(2000);
        s.c.setAlpha(f.p.online ? 1 : 0.4);
        s.body.setFlipX(f.face < 0);                                   // 往左跑就把身體和大頭一起鏡射
        s.head.setFlipX(f.face < 0);
        const l = f.lunge;
        // 衝刺殘影
        if (f.dashT > 0 && Math.floor(time / 40) !== s.lastTrail) { s.lastTrail = Math.floor(time / 40); this.dashTrail(s); }
        if (l) {
          // 頭槌中：頭從肩膀上方沿著瞄準方向伸出去，同時往下「俯衝」到球的高度；脖子畫成一條粗線
          const e = lungeExt(l), reach = NECK_MIN + (NECK_MAX - NECK_MIN) * l.power;
          const restX = f.x, restY = f.y - footToBody - (s.headY * -1) * CHAR_SCALE;          // 頭平常的位置（世界座標）
          const hitX = f.x + l.dir.x * reach, hitY = f.y + l.dir.y * reach - 8;
          const hx = restX + (hitX - restX) * e, hy = restY + (hitY - restY) * e;
          s.head.setPosition((hx - s.c.x) / CHAR_SCALE, (hy - s.c.y) / CHAR_SCALE);
          s.head.angle = l.dir.x * 14 * e * (f.face < 0 ? -1 : 1);
          s.head.setFlipX(l.dir.x < -0.1 ? true : l.dir.x > 0.1 ? false : f.face < 0);
          const sx = f.x, sy = f.y - footToBody - (s.headY * -1) * CHAR_SCALE + CharRender.HEAD_SIZE * 0.5 * CHAR_SCALE;   // 脖子根部（肩膀）
          s.neck.clear().setDepth(f.y - 0.5);
          s.neck.lineStyle(14, 0x111111).beginPath().moveTo(sx, sy).lineTo(hx, hy).strokePath();
          s.neck.lineStyle(9, Phaser.Display.Color.HexStringToColor(f.p.color).color).beginPath().moveTo(sx, sy).lineTo(hx, hy).strokePath();
        } else {
          s.neck.clear();
        }
        // 瞄準箭頭：蓄力時顯示球會往哪個方向飛（球在附近就從球畫出去，否則從腳下）；正對球門時變綠色
        s.aim.clear();
        if (f.charging && Hub.phase === 'playing') {
          const k = kickDirection(f, f.aim);
          const nearBall = Math.hypot(ball.x - f.x, ball.y - f.y) <= GRAB_RANGE;
          const ox = nearBall ? ball.x : f.x, oy = nearBall ? ball.y : f.y;
          const len = 60 + 80 * Math.max(f.charge, k.aimed ? AIM_POWER * k.drag : 0), tipX = ox + k.dir.x * len, tipY = oy + k.dir.y * len;
          const col = k.snapped ? 0x4ade99 : 0xfacc15, nx = -k.dir.y, ny = k.dir.x;
          s.aim.lineStyle(6, 0x111111).beginPath().moveTo(ox, oy).lineTo(tipX, tipY).strokePath();
          s.aim.lineStyle(3, col).beginPath().moveTo(ox, oy).lineTo(tipX, tipY).strokePath();
          s.aim.fillStyle(col).fillTriangle(tipX + k.dir.x * 14, tipY + k.dir.y * 14, tipX + nx * 9, tipY + ny * 9, tipX - nx * 9, tipY - ny * 9);
        }
        s.gauge.clear();
        if (f.charging) {                                                // 蓄力：腳下的圓弧越來越滿，顏色從黃變紅；身體壓低、頭微微發抖
          const col = Phaser.Display.Color.Interpolate.ColorWithColor(new Phaser.Display.Color(250, 204, 21), new Phaser.Display.Color(239, 68, 68), 100, f.charge * 100);
          const c32 = Phaser.Display.Color.GetColor(col.r, col.g, col.b);
          s.gauge.lineStyle(6, c32).beginPath().arc(f.x, f.y + 2, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, f.charge)).strokePath();
          s.body.setScale(CharRender.BODY_SCALE, CharRender.BODY_SCALE * (1 - 0.12 * f.charge));
          s.head.x = Math.sin(time / 25) * 3 * f.charge; s.head.y = s.headY + 4 * f.charge;
          s.head.angle = 0;
        } else {
          s.body.setScale(CharRender.BODY_SCALE);
        }
        if (l) { /* 頭的位置由上面的頭槌動畫決定 */ }
        else if (speed > 25) {
          s.body.anims.timeScale = Phaser.Math.Clamp(speed / 140, 0.6, 2.4);
          if (!s.body.anims.isPlaying) s.body.play('run-' + s.color);
          if (!f.charging) { s.head.x = 0; s.head.y = s.headY - Math.abs(Math.sin(t * 8 * s.body.anims.timeScale)) * 3; s.head.angle = Math.sin(t * 8 * s.body.anims.timeScale) * 4; }
        } else {
          if (s.body.anims.isPlaying) { s.body.anims.stop(); s.body.setFrame('f0'); }
          if (!f.charging) { s.head.x = 0; s.head.y = s.headY; if (!this.tweens.isTweening(s.head)) s.head.angle = 0; }
        }
      }
    }
  }

  // ============================================================
  // 給大廳（host.js）呼叫的介面
  // ============================================================
  function start() {
    for (const [id, p] of players) if (!p.online) players.delete(id);     // 離線的人這場不參加
    const list = [...players.values()].filter((p) => p.color).slice(0, MAX_PLAYERS);   // 選好角色與顏色的人，依加入順序，最多 10 人
    if (!list.length) return;

    clearTimers(); clearForfeit();
    players.forEach((p) => { delete p.soccer; });
    list.forEach((p, i) => { S(p).team = i % 2; });                       // 輪流分到紅、藍隊，人數會平均
    field = list.map((p) => newFielder(p, S(p).team));
    version++;
    score = [0, 0]; remainingMs = MATCH_SECONDS * 1000; overtime = false;
    centerText = ''; result = null; goalEvent = { n: 0, team: 0, scorerId: null };
    kickEvent = { n: 0, x: 0, y: 0, power: 0 }; dashEvent = { n: 0, id: null };
    $('soccerPanel').classList.add('hidden');
    Hub.game.scene.stop('soccer');
    Hub.game.scene.start('soccer');
    beginCountdown();
  }

  function stop() {
    clearTimers(); clearForfeit();
    field = []; version++;
    centerText = ''; result = null;
    players.forEach((p) => { delete p.soccer; });
    $('soccerPanel').classList.add('hidden');
    $('hud').textContent = '';
    Hub.game.scene.stop('soccer');
  }

  $('soccerAgainBtn').onclick = start;                  // 再來一場：重新分隊、重新開打
  $('soccerLobbyBtn').onclick = () => Hub.backToLobby();
  Hub.game.scene.add('soccer', SoccerScene, false);

  return {
    start,
    stop,
    // 手機的 input 事件：{ mx, my }（搖桿方向，-1~1）
    onInput(playerId, data) {
      const p = players.get(playerId);
      if (!p || !field.some((f) => f.p === p) || typeof data.mx !== 'number') return;
      const prev = S(p).input;
      S(p).input = { mx: data.mx, my: data.my, ax: data.ax || 0, ay: data.ay || 0, dash: !!data.dash, neck: !!data.neck, at: Date.now(),
        // 按下／放開如果剛好發生在兩次物理運算之間（畫面卡頓時），也要記下來，不然很快的一下會被吃掉
        neckDown: prev.neckDown || (!!data.neck && !prev.neck), neckUp: prev.neckUp || (!data.neck && !!prev.neck),
        aimLast: data.neck ? { x: data.ax || 0, y: data.ay || 0 } : prev.aimLast || { x: 0, y: 0 } };   // 按住時最後一次的瞄準方向（放開那一則的 ax、ay 是 0）
    },
    onPlayerLeft(p) {
      if (p.soccer) p.soccer.input = { mx: 0, my: 0, ax: 0, ay: 0, dash: false, neck: false, at: 0 };
      checkTeams();
    },
    onPlayerJoin() { checkTeams(); },                                  // 有人重連回來：取消棄權倒數
    onPhase(phase) {                                                   // 階段切換時更新結算面板
      $('soccerPanel').classList.toggle('hidden', phase !== 'result');
    },
    // 傳給某位玩家手機的足球狀態（和大廳的通用狀態合併）
    statusOf(p) {
      if (!field.some((f) => f.p === p)) return { role: 'late' };       // late = 本場開始後才加入，或超過 10 人
      const team = S(p).team;
      return {
        role: 'player', team: TEAMS[team].id, teamName: TEAMS[team].name, goals: S(p).goals,
        result: result ? (result.winner < 0 ? 'draw' : result.winner === team ? 'win' : 'lose') : null,
      };
    },
    stateExtra: () => ({ score }),                                      // 廣播給所有手機：目前比分
    lobbyInfo: (n) => n ? `已選好 ${n} 人，分紅藍兩隊（最多 ${MAX_PLAYERS} 人上場）` : '至少要有 1 人選好角色',
    // 測試用
    _state: () => ({ field: field.map((f) => ({ id: f.p.id, x: f.x, y: f.y, vx: f.vx, vy: f.vy, team: S(f.p).team, charge: f.charge, charging: f.charging, lunging: !!f.lunge, dashT: f.dashT, dashCd: f.dashCd })), ball: { ...ball }, score, remainingMs, overtime, phase: Hub.phase }),
    _set: (o) => { if (o.player) Object.assign(field[o.player.index], o.player.set); if (o.ball) Object.assign(ball, o.ball); if (o.lastIndex != null) ball.last = field[o.lastIndex]; if (o.remainingMs != null) remainingMs = o.remainingMs; },
  };
})();
Hub.games.soccer = SoccerGame;
