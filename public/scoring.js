// ============================================================
// scoring.js － 跨遊戲的累計積分（賽季）
//   - 每個遊戲結束時呼叫 Hub.Score.submit({ game, title, rows })，產生「待計分」的本場結果；
//     主持人按 [計分] 才累計到每位玩家身上，按 [試玩不計分] 就丟掉。
//   - 名次分：滿分 100，第 1 名 100、最後一名 0、中間平均分配（同名次平分），所以不管幾個人玩、玩哪個遊戲，分量都一樣。
//   - 表現加分：每個遊戲各自定義，上限 BONUS_MAX（由各遊戲算好傳進來）。
//   - AI 玩家算在名次裡（讓排名算得出來），但不進累計排名。
//   - 資料存在瀏覽器 localStorage（主畫面重新整理後還在；玩家用同一個 playerId 重連就是同一個人）。
// ============================================================
const Score = (() => {
  const { players, $, escapeHtml } = Hub;
  const KEY = 'pg-season';
  const BONUS_MAX = 20;
  let standings = {};            // playerId -> { id, name, color, total, bonus, firsts, games: [{ game, title, rank, base, bonus, pts }] }
  let pending = null;            // { game, title, rows: [{ id, name, ai, base, bonus, pts, rank }], n }
  try { standings = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { standings = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(standings)); } catch (e) { /* 略過 */ } };

  // 名次分：n 個人、名次 rank（同名次有 k 個人 → 平分這 k 個名次的分數）
  function rankPoints(rank, k, n) {
    if (n < 2) return 0;
    let sum = 0;
    for (let pos = rank; pos < rank + k; pos++) sum += 100 * (n - pos) / (n - 1);
    return Math.round(sum / k);
  }

  // rows: [{ p, rank?, base?, bonus? }]；有 base 就直接用（足球：勝 100／平 50／負 0），否則用 rank 算名次分
  function submit({ game, title, rows }) {
    const n = rows.length;
    const same = {};
    rows.forEach((r) => { if (r.rank != null) same[r.rank] = (same[r.rank] || 0) + 1; });
    const out = rows.map((r) => {
      const base = r.base != null ? r.base : rankPoints(r.rank, same[r.rank] || 1, n);
      const bonus = Math.max(0, Math.min(BONUS_MAX, Math.round(r.bonus || 0)));
      return { id: r.p.id, name: r.p.name, ai: !!r.p.ai, rank: r.rank != null ? r.rank : null, base, bonus, pts: n < 2 ? 0 : base + bonus };
    });
    pending = { game, title, rows: out, n };
    showBar();
  }
  const hasPending = () => !!pending;

  // ---------- 主持人的選擇 ----------
  function commit() {
    if (!pending) return;
    const got = [];
    for (const r of pending.rows) {
      if (r.ai) continue;                                       // AI 不進排名
      const p = players.get(r.id);
      const s = standings[r.id] || (standings[r.id] = { id: r.id, name: r.name, color: p ? p.color : '#888', total: 0, bonus: 0, firsts: 0, games: [] });
      s.name = r.name; if (p && p.color) s.color = p.color;
      s.total += r.pts; s.bonus += r.bonus;
      if (r.rank === 1 || r.base === 100) s.firsts++;
      s.games.push({ game: pending.game, title: pending.title, rank: r.rank, base: r.base, bonus: r.bonus, pts: r.pts });
      got.push(r);
    }
    save();
    const list = got.filter((r) => r.pts > 0).sort((a, b) => b.pts - a.pts);
    pending = null;
    Hub.sendAllStatus();
    showDone(list);
    renderLobby();
  }
  function discard() { pending = null; hideBar(); }        // 離開結算畫面：待計分的丟掉，提示條也收起來

  // ---------- 累計排名 ----------
  function ranking() {
    return Object.values(standings).sort((a, b) => b.total - a.total || b.firsts - a.firsts || b.bonus - a.bonus || a.name.localeCompare(b.name));
  }
  const entryOf = (p) => standings[p.id];
  const totalOf = (p) => (standings[p.id] ? standings[p.id].total : 0);
  function rankOf(p) {
    const s = standings[p.id]; if (!s) return 0;
    const r = ranking(); let pos = 1;
    for (const x of r) { if (x.total > s.total || (x.total === s.total && (x.firsts > s.firsts || (x.firsts === s.firsts && x.bonus > s.bonus)))) pos++; }
    return pos;
  }
  function lastOf(p) { const s = standings[p.id]; return s && s.games.length ? s.games[s.games.length - 1].pts : 0; }
  // 給手機看的賽季狀態
  function statusOf(p) {
    const s = standings[p.id];
    if (!s) return null;
    return { total: s.total, rank: rankOf(p), last: lastOf(p), games: s.games.length };
  }
  function reset() { standings = {}; pending = null; save(); Hub.sendAllStatus(); renderLobby(); hideBar(); }

  // ---------- 畫面 ----------
  const bar = $('scoreBar');
  function showBar() {
    $('scoreMsg').innerHTML = `<b>${escapeHtml(pending.title)}</b> 結束了：要把這一場計入累計分數嗎？`;
    $('scoreYes').classList.remove('hidden'); $('scoreNo').classList.remove('hidden');
    $('scoreYes').textContent = '✔ 計分'; $('scoreNo').textContent = '🎮 試玩不計分';
    bar.classList.remove('hidden');
  }
  function showDone(list) {
    $('scoreMsg').innerHTML = '✅ 已計分　' + (list.length ? list.slice(0, 8).map((r) => `${escapeHtml(r.name)} <b>+${r.pts}</b>`).join('、') + (list.length > 8 ? '…' : '') : '（這一場沒有人得分）');
    $('scoreYes').classList.add('hidden'); $('scoreNo').classList.add('hidden');
    bar.classList.remove('hidden');
    clearTimeout(showDone.t); showDone.t = setTimeout(hideBar, 9000);
  }
  function hideBar() { bar.classList.add('hidden'); }
  $('scoreYes').onclick = commit;
  $('scoreNo').onclick = () => { pending = null; $('scoreMsg').textContent = '本場不計分'; $('scoreYes').classList.add('hidden'); $('scoreNo').classList.add('hidden'); clearTimeout(showDone.t); showDone.t = setTimeout(hideBar, 2500); };

  // 結算排名面板（大廳的「🏆 結算排名」）
  function openStandings() {
    const r = ranking();
    const medal = ['🥇', '🥈', '🥉'];
    const tie = (x, y) => x.total === y.total && x.firsts === y.firsts && x.bonus === y.bonus;      // 總分、第一名次數、表現加分都一樣 = 並列
    const place = r.map((s, i) => { let k = i; while (k > 0 && tie(r[k - 1], s)) k--; return k; });
    $('standList').innerHTML = r.length ? r.map((s, i) => {
      const detail = s.games.map((g) => `<span class="gp" title="${escapeHtml(g.title)}：名次分 ${g.base} + 加分 ${g.bonus}">${escapeHtml(g.title)} <b>${g.pts}</b></span>`).join('');
      return `<li style="--c:${s.color}"><span class="no">${medal[place[i]] || place[i] + 1}</span><span class="nm">${escapeHtml(s.name)}</span><span class="tot">${s.total} 分</span><span class="dt">${detail || '還沒有計分的遊戲'}</span></li>`;
    }).join('') : '<li class="empty">還沒有累計的分數：每個遊戲結束後按「✔ 計分」</li>';
    $('standNote').textContent = r.length ? `共 ${Math.max(...r.map((s) => s.games.length))} 場　名次分滿分 100 ＋ 表現加分最多 20　AI 不列入` : '';
    $('standPanel').classList.remove('hidden');
  }
  $('standBtn').onclick = openStandings;
  $('standClose').onclick = () => $('standPanel').classList.add('hidden');
  $('standReset').onclick = () => { if (confirm('確定要清空所有累計分數、重新開始賽季嗎？')) { reset(); openStandings(); } };

  return { submit, commit, discard, hasPending, ranking, totalOf, rankOf, statusOf, reset, rankPoints, openStandings, BONUS_MAX, _standings: () => standings };
})();
Hub.Score = Score;
