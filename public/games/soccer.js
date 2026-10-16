// ============================================================
// games/soccer.js － 「足球」遊戲（M1：俯視球場 + 球 + 球門 + 搖桿移動 + 推球）
//   - 物理全部在 host 端算（固定 60Hz）；手機只送搖桿方向 { mx, my }
//   - 角色沿用跑步的做法（CharRender：大頭 + 跑步身體）
//   - 還沒有：分隊、進球計分、倒數與時間、頭槌／衝刺（M2、M3）
//   - 和大廳（host.js）的溝通只透過 Hub 與下面回傳的介面
// ============================================================
const SoccerGame = (() => {
  const { players, $, setPhase } = Hub;

  // ---------- 球場（畫布 1280x720，俯視）----------
  const FIELD = { l: 100, r: 1180, t: 110, b: 690 };
  const CX = (FIELD.l + FIELD.r) / 2, CY = (FIELD.t + FIELD.b) / 2;
  const GOAL_H = 190, GOAL_D = 56;          // 球門開口高度、球門往場外凹進去的深度

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
  const STEP = 1 / 60;           // 物理固定步長

  // ---------- 這個遊戲的狀態 ----------
  // 每位玩家的足球狀態放在 p.soccer（回大廳時清掉）
  const S = (p) => p.soccer || (p.soccer = { input: { mx: 0, my: 0, at: 0 } });
  let field = [];                // 場上的角色 { p, x, y, vx, vy, face }
  let ball = { x: CX, y: CY, vx: 0, vy: 0, rot: 0 };
  let version = 0;               // 場上角色換了就加一，場景據此重建

  // ============================================================
  // 物理
  // ============================================================
  function resetBall() { ball = { x: CX, y: CY, vx: 0, vy: 0, rot: 0 }; }

  // 開球前的站位：圍著球排成一圈
  function spawn(list) {
    field = list.map((p, i) => {
      const a = (i / list.length) * Math.PI * 2 + Math.PI;
      return { p, x: CX + Math.cos(a) * 220, y: CY + Math.sin(a) * 180, vx: 0, vy: 0, face: 1 };
    });
    version++;
  }

  function stepPhysics(dt) {
    const now = Date.now();
    // 角色：搖桿方向 → 目標速度，慢慢加速過去
    for (const f of field) {
      const inp = S(f.p).input;
      let mx = inp.mx, my = inp.my;
      if (now - inp.at > INPUT_TIMEOUT_MS) { mx = 0; my = 0; }
      const mag = Math.hypot(mx, my);
      if (mag > 1) { mx /= mag; my /= mag; }
      const k = 1 - Math.exp(-ACCEL * dt);
      f.vx += (mx * MAX_SPEED - f.vx) * k;
      f.vy += (my * MAX_SPEED - f.vy) * k;
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
    // 球和角色：角色把球推開（把角色當作很重的東西）
    for (const f of field) {
      const dx = ball.x - f.x, dy = ball.y - f.y, d = Math.hypot(dx, dy), min = PLAYER_R + BALL_R;
      if (d > 0 && d < min) {
        const nx = dx / d, ny = dy / d;
        ball.x = f.x + nx * min; ball.y = f.y + ny * min;           // 先分開，避免卡進去
        const relN = (ball.vx - f.vx) * nx + (ball.vy - f.vy) * ny;   // 球相對角色、沿著連線的速度
        if (relN < 0) { ball.vx -= (1 + HIT_BOUNCE) * relN * nx; ball.vy -= (1 + HIT_BOUNCE) * relN * ny; }
      }
    }
    collideBallWalls();
  }

  // 球撞到場邊會彈回；球門開口的地方可以進到球門裡面（M1 還不算進球）
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
  // 畫面層（Phaser）：場地、球、角色（沿用跑步的身體與大頭）
  // ============================================================
  class SoccerScene extends Phaser.Scene {
    create() {
      this.acc = 0;
      this.sprites = [];
      this.version = -1;
      this.drawField();
      // 球：陰影 + 白底黑邊 + 中間一塊深色
      this.ballShadow = this.add.ellipse(0, 0, BALL_R * 2, BALL_R * 0.9, 0x000000, 0.3).setDepth(1);
      const g = this.add.graphics();
      g.fillStyle(0xffffff).fillCircle(0, 0, BALL_R).lineStyle(3, 0x111111).strokeCircle(0, 0, BALL_R);
      g.fillStyle(0x222222).fillCircle(0, 0, 6).fillCircle(-10, -4, 3).fillCircle(9, 5, 3).fillCircle(2, -11, 3);
      this.ballSprite = this.add.container(CX, CY, [g]);
      this.add.text(CANVAS_W / 2, 56, '足球（測試版）', { fontSize: '40px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
    }

    drawField() {
      const g = this.add.graphics();
      // 草地：直條紋
      const stripe = 90;
      for (let x = FIELD.l, i = 0; x < FIELD.r; x += stripe, i++) {
        g.fillStyle(i % 2 ? 0x2f8f4e : 0x37a05a).fillRect(x, FIELD.t, Math.min(stripe, FIELD.r - x), FIELD.b - FIELD.t);
      }
      // 球門（場外凹進去的區塊）+ 網子
      for (const side of [-1, 1]) {
        const gx = side < 0 ? FIELD.l - GOAL_D : FIELD.r;
        g.fillStyle(0x1b2a38).fillRect(gx, CY - GOAL_H / 2, GOAL_D, GOAL_H);
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

    // 依場上角色重建：身體（跑步動畫）+ 大頭 + 名字 + 陰影
    rebuild() {
      this.sprites.forEach((s) => { s.c.destroy(); s.label.destroy(); s.shadow.destroy(); });
      this.sprites = field.map((f) => {
        const p = f.p;
        const body = this.add.sprite(0, 0, CharRender.ensureBody(this, p.color), 'f0').setScale(CharRender.BODY_SCALE);
        const headY = (24 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE - CharRender.HEAD_SIZE / 2 + 4;
        const head = this.add.image(0, headY, p.photo ? 'head-' + p.id : 'char-' + p.charId)
          .setDisplaySize(CharRender.HEAD_SIZE, CharRender.HEAD_SIZE);
        const c = this.add.container(f.x, f.y, [body, head]).setScale(CHAR_SCALE);
        const label = this.add.text(f.x, f.y, p.name, { fontSize: '16px', color: '#fff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
        const shadow = this.add.ellipse(f.x, f.y, PLAYER_R * 2.2, PLAYER_R * 0.9, 0x000000, 0.3).setDepth(1);
        return { f, c, body, head, label, shadow, headY, color: p.color };
      });
      this.version = version;
    }

    update(time, delta) {
      if (this.version !== version) this.rebuild();
      // 固定步長物理（畫面卡頓時最多補 6 步）
      this.acc = Math.min(this.acc + delta / 1000, STEP * 6);
      while (this.acc >= STEP) { stepPhysics(STEP); this.acc -= STEP; }

      // 球
      this.ballSprite.setPosition(ball.x, ball.y).setRotation(ball.rot).setDepth(ball.y);
      this.ballShadow.setPosition(ball.x, ball.y + BALL_R * 0.8);
      // 角色
      const t = time / 1000;
      for (const s of this.sprites) {
        const f = s.f, speed = Math.hypot(f.vx, f.vy);
        const footToBody = (92 - CharRender.BODY_FRAME_H / 2) * CharRender.BODY_SCALE * CHAR_SCALE;   // 腳到身體中心的距離
        s.c.setPosition(f.x, f.y - footToBody).setDepth(f.y);
        s.shadow.setPosition(f.x, f.y + 2);
        s.label.setPosition(f.x, f.y - footToBody - (CharRender.HEAD_SIZE * 0.5 - s.headY) * CHAR_SCALE - 16).setDepth(2000);
        s.c.setAlpha(f.p.online ? 1 : 0.4);
        s.body.setFlipX(f.face < 0);                                   // 往左跑就把身體和大頭一起鏡射
        s.head.setFlipX(f.face < 0);
        if (speed > 25) {
          s.body.anims.timeScale = Phaser.Math.Clamp(speed / 140, 0.6, 2.4);
          if (!s.body.anims.isPlaying) s.body.play('run-' + s.color);
          s.head.y = s.headY - Math.abs(Math.sin(t * 8 * s.body.anims.timeScale)) * 3;
          s.head.angle = Math.sin(t * 8 * s.body.anims.timeScale) * 4;
        } else {
          if (s.body.anims.isPlaying) { s.body.anims.stop(); s.body.setFrame('f0'); }
          s.head.y = s.headY; s.head.angle = 0;
        }
      }
    }
  }

  // ============================================================
  // 給大廳（host.js）呼叫的介面
  // ============================================================
  function start() {
    for (const [id, p] of players) if (!p.online) players.delete(id);     // 離線的人這場不參加
    const list = [...players.values()].filter((p) => p.color);            // 只有選好角色與顏色的人上場
    if (!list.length) return;
    players.forEach((p) => { delete p.soccer; });
    resetBall();
    spawn(list);
    Hub.game.scene.stop('soccer');
    Hub.game.scene.start('soccer');
    setPhase('playing');
  }

  function stop() {
    field = []; version++;
    players.forEach((p) => { delete p.soccer; });
    $('hud').textContent = '';
    Hub.game.scene.stop('soccer');
  }

  Hub.game.scene.add('soccer', SoccerScene, false);

  return {
    start,
    stop,
    // 手機的 input 事件：{ mx, my }（搖桿方向，-1~1）
    onInput(playerId, data) {
      const p = players.get(playerId);
      if (!p || !field.some((f) => f.p === p) || typeof data.mx !== 'number') return;
      S(p).input = { mx: data.mx, my: data.my, at: Date.now() };
    },
    onPlayerLeft(p) { if (p.soccer) p.soccer.input = { mx: 0, my: 0, at: 0 }; },
    onPhase() { $('hud').textContent = ''; },
    statusOf: (p) => ({ role: field.some((f) => f.p === p) ? 'player' : 'late' }),   // late = 本場開始後才加入
    stateExtra: () => ({}),
    lobbyInfo: (n) => n ? `已選好 ${n} 人（測試版：用搖桿跑位、推球）` : '至少要有 1 人選好角色',
    // 測試用
    _state: () => ({ field: field.map((f) => ({ x: f.x, y: f.y, vx: f.vx, vy: f.vy })), ball: { ...ball } }),
  };
})();
Hub.games.soccer = SoccerGame;
