// ============================================================
// games/quiz.js － 「猜猜他是誰」：類似 Kahoot 的搶答
//   - 主畫面顯示一張照片，要猜的那個人被黑色剪影蓋住；手機上有 A B C D 四個大按鈕
//   - 答對得分，越快分數越高（500~1000），連續答對有加成；全部答完或時間到 → 剪影淡出、揭曉答案 → 排行榜 → 下一題
//   - 題目在 public/quiz/questions.json（原圖 + 黑色剪影遮罩 + 選項 + 答案）
//   - 階段 phase：quizIntro → question → reveal → scores → (下一題 ...) → result
// ============================================================
const QuizGame = (() => {
  const { players, $, escapeHtml, setPhase, sendStatus } = Hub;

  // ---------- 數值 ----------
  const INTRO_MS = 2200;        // 「第 N 題」過場
  const REVEAL_MS = 5500;       // 揭曉停留
  const SCORES_MS = 4500;       // 排行榜停留
  const BASE_POINTS = 500;      // 答對的基本分；剩餘時間比例再加最多 500
  const STREAK_BONUS = 100;     // 連續答對：第 2 題起每多一題 +100，最多 +300
  const INTRO_SFX = 'audio/pokeguess_6s.mp3';   // 每題開始播放的音檔（原檔 pokeguess.mp3 的前 6 秒，最後 0.5 秒淡出）
  const OPTS = [                // 四個選項的顏色與形狀（和手機按鈕一致）
    { label: 'A', color: '#ef4444', shape: '▲' }, { label: 'B', color: '#3b82f6', shape: '◆' },
    { label: 'C', color: '#eab308', shape: '●' }, { label: 'D', color: '#22c55e', shape: '■' },
  ];

  // 每位玩家：{ score, streak, ans（-1 = 還沒答）, at（答題時間）, gain, correct, rank, counted }
  const S = (p) => p.quiz || (p.quiz = { score: 0, streak: 0, right: 0, ans: -1, at: 0, gain: 0, correct: null, rank: 0 });
  let bank = null;              // questions.json
  let deck = [], idx = -1, seconds = 15, deadline = 0, counts = [0, 0, 0, 0], timers = [], tickTimer = null;
  let participants = [];        // 這場上場的人（開局時決定）
  const q = () => deck[idx];
  // 產生這一題的四個選項：有 name 的題目 = 正確答案 + 3 個干擾（干擾名單 decoys + 其他題的答案，隨機挑、不重複），位置隨機；沒有 name 的題目沿用 options／answer
  function prepare(base) {
    if (base.name == null) return base;
    const pool = [...new Set([...(bank.decoys || []), ...bank.questions.map((x) => x.name)].filter((x) => x != null && x !== base.name))];
    const options = shuffle([base.name, ...shuffle(pool).slice(0, 3)]);
    return { ...base, options, answer: options.indexOf(base.name) };
  }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; clearInterval(tickTimer); tickTimer = null; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ranked = () => [...participants].sort((a, b) => S(b).score - S(a).score);
  function assignRanks() { ranked().forEach((p, i) => { S(p).rank = i + 1; }); }

  // ---------- 畫面（DOM）----------
  const el = { panel: $('quizPanel'), num: $('qNum'), bar: $('qBar'), sec: $('qSec'), img: $('qImg'), mask: $('qMask'), banner: $('qBanner'),
    opts: $('qOpts'), board: $('qBoard'), boardList: $('qBoardList'), boardTitle: $('qBoardTitle'), result: $('qResult'), resultList: $('qResultList'), stage: $('qStage'), top: $('qTop') };
  function renderOpts(state) {                       // state：'question'（全亮）、'reveal'（答案亮、其他暗，顯示人數）
    const cur = q();
    el.opts.innerHTML = OPTS.map((o, i) => {
      const dim = state === 'reveal' && i !== cur.answer, right = state === 'reveal' && i === cur.answer;
      return `<div class="qo${dim ? ' dim' : ''}${right ? ' right' : ''}" style="--c:${o.color}"><span class="sh">${o.shape}</span><b>${escapeHtml(cur.options[i] != null ? String(cur.options[i]) : o.label)}</b>` +
        (state === 'reveal' ? `<span class="cnt">${counts[i]} 人</span>` : '') + `</div>`;
    }).join('');
  }
  function renderBoard(title, rows) {
    el.boardTitle.textContent = title;
    el.boardList.innerHTML = rows.map((p, i) => `<li><span>${i + 1}. ${escapeHtml(p.name)}</span><span>${S(p).score} 分${S(p).gain ? `　<em>+${S(p).gain}</em>` : ''}</span></li>`).join('');
  }
  function show(section) {                           // 主畫面三種內容：題目（stage + opts）／排行榜／最終結果
    el.top.classList.toggle('hidden', section !== 'question');
    el.stage.classList.toggle('hidden', section !== 'question');
    el.opts.classList.toggle('hidden', section !== 'question');
    el.board.classList.toggle('hidden', section !== 'scores');
    el.result.classList.toggle('hidden', section !== 'result');
  }

  // ---------- 流程 ----------
  async function loadBank() {
    if (bank) return bank;
    bank = await (await fetch('quiz/questions.json', { cache: 'no-cache' })).json();
    return bank;
  }
  async function start() {
    for (const [id, p] of players) if (!p.online) players.delete(id);
    const list = [...players.values()].filter((p) => p.color);
    if (!list.length) return;
    try { await loadBank(); } catch (e) { alert('讀不到題庫 quiz/questions.json'); Hub.backToLobby(); return; }
    clearTimers();
    participants = list;
    players.forEach((p) => { delete p.quiz; });
    participants.forEach((p) => S(p));
    deck = shuffle(bank.questions); idx = -1; seconds = bank.seconds || 15;
    Sfx.preload(INTRO_SFX);                                              // 先把每題開始的音檔抓好、解碼好
    $('qAgainBtn').onclick = start; $('qLobbyBtn').onclick = () => Hub.backToLobby();
    nextQuestion();
  }
  function stop() {
    clearTimers();
    players.forEach((p) => { delete p.quiz; });
    participants = []; deck = []; idx = -1;
    el.panel.classList.add('hidden');
    $('hud').textContent = '';
  }

  function nextQuestion() {
    clearTimers();
    idx++;
    if (idx >= deck.length) { showFinal(); return; }
    deck[idx] = prepare(deck[idx]);
    participants.forEach((p) => { const s = S(p); s.ans = -1; s.at = 0; s.gain = 0; s.correct = null; });
    counts = [0, 0, 0, 0];
    el.num.textContent = `第 ${idx + 1} / ${deck.length} 題`;
    el.img.src = q().image; el.mask.src = q().mask;
    el.mask.style.transition = 'none'; el.mask.style.opacity = 1;
    el.banner.textContent = ''; el.sec.textContent = seconds;
    el.bar.style.width = '100%'; el.bar.classList.remove('low');
    renderOpts('question'); show('question');
    setPhase('quizIntro');
    el.banner.textContent = `第 ${idx + 1} 題　這是誰？`; el.banner.classList.add('show');
    Sfx.playFile(INTRO_SFX, { dur: 6, vol: 1.6 });                         // 每題一開始播（配樂會暫時壓小）
    Promise.all([el.img.decode(), el.mask.decode()]).catch(() => {}).then(() => later(beginAnswering, INTRO_MS));
  }
  function beginAnswering() {
    el.banner.classList.remove('show');
    deadline = Date.now() + seconds * 1000;
    setPhase('question'); Sfx.play('go');
    tickTimer = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      el.bar.style.width = (left / (seconds * 1000) * 100) + '%';
      el.bar.classList.toggle('low', left < 5000);
      const s = Math.ceil(left / 1000);
      if (el.sec.textContent !== String(s)) { el.sec.textContent = s; if (s <= 3 && s > 0) Sfx.play('beep'); }
    }, 100);
    later(endQuestion, seconds * 1000 + 100);
  }

  function endQuestion() {
    if (Hub.phase !== 'question') return;
    clearTimers();
    const cur = q();
    participants.forEach((p) => {
      const s = S(p);
      if (s.ans >= 0) counts[s.ans]++;
      if (s.ans === cur.answer) {
        const left = Math.max(0, 1 - (s.at - (deadline - seconds * 1000)) / (seconds * 1000));     // 剩餘時間比例（越快越高）
        s.streak++;
        s.gain = Math.round(BASE_POINTS + BASE_POINTS * left) + Math.min(3, s.streak - 1) * STREAK_BONUS;
        s.correct = true; s.right++;
      } else { s.streak = 0; s.gain = 0; s.correct = false; }
      s.score += s.gain;
    });
    assignRanks();
    renderOpts('reveal');
    el.mask.style.transition = 'opacity 1.1s ease'; el.mask.style.opacity = 0;        // 剪影淡出，露出原圖
    const right = participants.filter((p) => S(p).correct).length;
    el.banner.textContent = `${right} / ${participants.length} 人答對`; el.banner.classList.add('show');
    el.bar.style.width = '0%';
    setPhase('reveal'); Sfx.play(right ? 'correct' : 'wrong');
    later(() => { el.banner.classList.remove('show'); showScores(); }, REVEAL_MS);
  }
  function showScores() {
    if (idx + 1 >= deck.length) { showFinal(); return; }
    renderBoard('目前排名', ranked().slice(0, 5)); show('scores');
    setPhase('scores');
    later(nextQuestion, SCORES_MS);
  }
  function showFinal() {
    clearTimers(); assignRanks();
    const rows = ranked();
    el.resultList.classList.toggle('many', rows.length > 6);
    el.resultList.innerHTML = rows.map((p, i) => `<li><span>${i === 0 ? '👑 ' : ''}${i + 1}. ${escapeHtml(p.name)}</span><span>${S(p).score} 分</span></li>`).join('');
    show('result'); setPhase('result'); Sfx.play('win');
    // 計分：依總分名次（同分並列）；表現加分 = 答對題數 ×4（上限 +20）
    Hub.Score.submit({ game: 'quiz', title: '猜猜他是誰', rows: rows.map((p) => ({ p, rank: 1 + rows.filter((x) => S(x).score > S(p).score).length, bonus: S(p).right * 4 })) });
  }

  // ---------- 給大廳（host.js）呼叫的介面 ----------
  return {
    start, stop,
    // 手機的 input 事件：{ ans: 0~3 } 是選了哪個選項（只算第一次）
    onInput(playerId, data) {
      const p = players.get(playerId);
      if (!p || !p.quiz || Hub.phase !== 'question' || typeof data.ans !== 'number' || data.ans < 0 || data.ans > 3) return;
      const s = S(p);
      if (s.ans >= 0) return;
      s.ans = data.ans; s.at = Date.now();
      sendStatus(p);
      if (participants.filter((x) => x.online).every((x) => S(x).ans >= 0)) later(endQuestion, 700);      // 全部答完就提早揭曉
    },
    onPlayerLeft() { if (Hub.phase === 'question' && participants.filter((x) => x.online).every((x) => S(x).ans >= 0)) later(endQuestion, 700); },
    onPlayerJoin() {},
    onPhase(phase) {
      el.panel.classList.toggle('hidden', phase === 'lobby');
      $('hud').textContent = '';
    },
    statusOf(p) {
      if (!p.quiz) return { role: 'late' };
      const s = S(p), cur = q();
      return {
        role: 'player', q: idx + 1, total: deck.length, answered: s.ans >= 0, choice: s.ans,
        correct: s.correct, gain: s.gain, score: s.score, rank: s.rank, streak: s.streak,
        answer: Hub.phase === 'reveal' || Hub.phase === 'scores' || Hub.phase === 'result' ? (cur ? cur.answer : null) : null,
        options: cur ? cur.options.map((o, i) => (o != null ? String(o) : OPTS[i].label)) : [], count: participants.length,
      };
    },
    stateExtra: () => ({ q: idx + 1, total: deck.length }),
    lobbyInfo: (n) => n ? `已選好 ${n} 人，黑色剪影搶答（答對越快分數越高）` : '至少要有 1 人選好角色',
    // 測試用
    _state: () => ({ phase: Hub.phase, idx, total: deck.length, answer: q() ? q().answer : null, deadline, seconds,
      players: participants.map((p) => ({ id: p.id, name: p.name, score: S(p).score, ans: S(p).ans, gain: S(p).gain, streak: S(p).streak, rank: S(p).rank })) }),
  };
})();
Hub.games.quiz = QuizGame;
