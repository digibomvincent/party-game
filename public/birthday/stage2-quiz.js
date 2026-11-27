// ============================================================
// 第 2 關：回憶大考驗（選擇題）
// 題目寫在 config.js 的 quiz，題型：
//   choice：一般選擇題，可以加照片（zoom 只露出一小塊，答對後拉遠揭曉）
//   order ：把旅行照時間排好（直接用第 1 關的 trips，config 的順序就是正確答案）
//   love  ：四個選項全是你的名字
// 答錯不會卡關：會有好笑的反應，再選一次就好。最後統計「一次就答對」幾題。
// ============================================================
window.Stage2 = (() => {
  const RIGHT = ['答對了！不愧是你 😍', '記得好清楚 🥹', '滿分女友 💯', '果然有在用心 💕', '太厲害了吧 🤩'];
  const WRONG = ['什麼？！你居然忘了 😭', '再給你一次機會 😤', '我要哭了… 再想想 🥲', '欸～不是這個啦 🙈', '扣一個親親 😗'];
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function restart(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // 照片（可只露出一小塊）；檔案不在時顯示檔名
  function photoHtml(q) {
    const z = q.zoom || {};
    const style = z.scale ? `transform: scale(${z.scale}); transform-origin: ${z.x ?? 50}% ${z.y ?? 50}%;` : '';
    return `<div class="quiz-photo">
        <img src="${esc(q.image)}" alt="" style="${style}"
             onerror="this.parentNode.classList.add('missing');this.parentNode.innerHTML='📷 這裡要放照片<br><code>${esc(q.image)}</code>'">
      </div>`;
  }

  async function run(container, ctx) {
    const cfg = ctx.cfg;
    const questions = (cfg.quiz || []).filter((q) => q.type !== 'order' || (cfg.trips || []).length >= 2);
    const screen = el('div', 'screen quiz-screen');
    container.appendChild(screen);

    // ---------- 開場 ----------
    screen.innerHTML = `<div class="stage-card">
        <div class="emoji">📝</div>
        <div class="stage-no">STAGE 2</div>
        <h2>回憶大考驗</h2>
        <p>一共 ${questions.length} 題\n答錯不會怎樣…只是我會很難過 🥲</p>
        <button class="big-btn">開始作答</button>
      </div>`;
    await new Promise((r) => (screen.querySelector('button').onclick = r));

    let score = 0;
    for (let i = 0; i < questions.length; i++) {
      const firstTry = await ask(screen, questions[i], i, questions.length, cfg);
      if (firstTry) score++;
    }

    // ---------- 成績 ----------
    const ratio = questions.length ? score / questions.length : 1;
    const comment =
      ratio === 1 ? '全對！你根本是我們回憶的資料庫 🏆' :
      ratio >= 0.7 ? '很厲害！錯的那幾題就當作沒發生過 😆' :
      ratio >= 0.4 ? '嗯…看來我們要再多出去玩幾次了 😏' :
      '沒關係！以後的回憶我們一起慢慢記 💕';
    screen.innerHTML = `<div class="stage-card">
        <div class="emoji">🏅</div>
        <h2>考試結束！</h2>
        <div class="quiz-score"><b>${score}</b> / ${questions.length}</div>
        <p>一次就答對 ${score} 題\n${esc(comment)}</p>
        <button class="big-btn">前往第 3 關 →</button>
      </div>`;
    if (ratio >= 0.7) FX.rain(2200);
    await new Promise((r) => (screen.querySelector('button').onclick = r));
  }

  // 問一題，回傳「是不是第一次就答對」
  function ask(screen, q, index, total, cfg) {
    return new Promise((resolve) => {
      const card = el('div', 'stage-card quiz-card');
      card.innerHTML = `
        <div class="quiz-top">
          <span class="quiz-no">Q${index + 1}</span>
          <div class="quiz-dots">${Array.from({ length: total }, (_, k) => `<i class="${k < index ? 'done' : k === index ? 'now' : ''}"></i>`).join('')}</div>
        </div>
        <h3 class="quiz-q">${esc(q.q)}</h3>
        ${q.image ? photoHtml(q) : ''}
        ${q.type === 'order' ? '<p class="quiz-tip">照時間順序，依序點一下（點錯可以再點一次取消）</p>' : ''}
        <div class="quiz-options"></div>
        <div class="quiz-feedback" hidden></div>
        <div class="quiz-next" hidden><button class="big-btn">${index === total - 1 ? '看成績 🏅' : '下一題 →'}</button></div>`;
      screen.replaceChildren(card);

      const optionsEl = card.querySelector('.quiz-options');
      const feedback = card.querySelector('.quiz-feedback');
      const next = card.querySelector('.quiz-next');
      let firstTry = true;

      function say(text, good) {
        feedback.hidden = false;
        feedback.className = `quiz-feedback ${good ? 'good' : 'bad'}`;
        feedback.textContent = text;
        restart(feedback, 'pop');
      }
      function win(fromEl) {
        say(q.right || pick(RIGHT), true);
        if (q.note) {
          const note = el('p', 'quiz-note', esc(q.note));
          feedback.after(note);
        }
        const photo = card.querySelector('.quiz-photo img');
        if (photo) photo.style.transform = 'scale(1)';
        FX.burstAt(fromEl);
        next.hidden = false;
        next.querySelector('button').onclick = () => resolve(firstTry);
        setTimeout(() => next.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
      }
      function lose(text) {
        firstTry = false;
        say(text || q.wrong || pick(WRONG), false);
      }

      // ---------- 一般選擇題 ----------
      if (q.type === 'choice' || !q.type) {
        q.options.forEach((label, k) => {
          const b = el('button', 'quiz-opt', `<span class="quiz-letter">${'ABCD'[k] || k + 1}</span>${esc(label)}`);
          b.onclick = () => {
            if (!next.hidden || b.disabled) return;
            if (k === q.answer) {
              b.classList.add('right');
              optionsEl.querySelectorAll('.quiz-opt').forEach((o) => (o.disabled = true));
              win(b);
            } else {
              b.classList.add('wrong');
              b.disabled = true;
              restart(b, 'shake');
              lose();
            }
          };
          optionsEl.appendChild(b);
        });
      }

      // ---------- 四個選項都是你 ----------
      if (q.type === 'love') {
        const name = cfg.myName || '我';
        const labels = q.options || [name, name, name, name];
        labels.forEach((label, k) => {
          const b = el('button', 'quiz-opt', `<span class="quiz-letter">${'ABCD'[k]}</span>${esc(label)}`);
          b.onclick = () => {
            if (!next.hidden) return;
            b.classList.add('right');
            optionsEl.querySelectorAll('.quiz-opt').forEach((o) => (o.disabled = true));
            win(b);
            FX.rain(2000, ['💖', '💕', '😘', '💗']);
          };
          optionsEl.appendChild(b);
        });
      }

      // ---------- 排順序 ----------
      if (q.type === 'order') {
        const items = (q.items || cfg.trips.map((t) => ({ label: t.title, flag: t.flag }))).map((it, k) => ({ ...it, k }));
        let display = shuffle(items);
        // 不要一開始就剛好是正確順序
        while (display.length > 1 && display.every((it, k) => it.k === k)) display = shuffle(items);
        const chosen = [];
        optionsEl.classList.add('order');
        const buttons = display.map((it) => {
          const b = el('button', 'quiz-opt order-opt', `<span class="order-no"></span><span class="order-flag">${esc(it.flag || '📍')}</span>${esc(it.label)}`);
          b.onclick = async () => {
            if (!next.hidden || optionsEl.classList.contains('checking')) return;
            const at = chosen.indexOf(it);
            if (at >= 0) chosen.splice(at, 1); else chosen.push(it);
            draw();
            if (chosen.length === items.length) {
              optionsEl.classList.add('checking');
              await sleep(350);
              if (chosen.every((c, k) => c.k === k)) {
                buttons.forEach((x) => x.classList.add('right'));
                win(optionsEl);
              } else {
                buttons.forEach((x) => restart(x, 'shake'));
                lose(q.wrong || '順序不對喔～我們重來一次 🤔');
                await sleep(900);
                chosen.length = 0;
                draw();
              }
              optionsEl.classList.remove('checking');
            }
          };
          b._item = it;
          optionsEl.appendChild(b);
          return b;
        });
        const draw = () => buttons.forEach((b) => {
          const n = chosen.indexOf(b._item);
          b.classList.toggle('picked', n >= 0);
          b.querySelector('.order-no').textContent = n >= 0 ? n + 1 : '';
        });
      }
    });
  }

  return { run };
})();
