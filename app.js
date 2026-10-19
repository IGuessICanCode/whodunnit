/* Karaoke Express v2 — Mood Labs. Every singer for themselves, live scoreboard. */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const POINTS = 10;
  const MAX_PLAYERS = 10;
  const TROPHY_LINES = ["Will never shut up about this win", "Unnecessarily competitive", "Bragging rights: unlocked", "Certified playback singer"];

  const state = {
    lang: "hindi",
    target: 70,
    players: [],          // { name, score } in join order — tiles never move
    deck: [],
    word: "",
    wordNo: 0,
    scoredIdx: null,      // who got this word (null = still open)
    sound: true,
    over: false,
    session: null,        // Firebase doc ref
    startedAt: 0,
    lastTrophy: -1,
  };

  /* ---------- Fit the 390×844 stage to any screen ---------- */
  function fit() {
    const s = Math.min(window.innerWidth / 390, window.innerHeight / 844);
    document.documentElement.style.setProperty("--scale", s);
  }
  window.addEventListener("resize", fit);
  fit();

  /* ---------- Storage (never required) ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  /* ---------- Sound ---------- */
  const sounds = {};
  ["success", "start"].forEach((n) => { try { sounds[n] = new Audio("assets/" + n + ".mp3"); } catch (e) {} });
  function play(n) {
    if (!state.sound || !sounds[n]) return;
    try { sounds[n].currentTime = 0; const p = sounds[n].play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }

  /* ---------- Screens ---------- */
  function show(id) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "s-" + id));
  }

  /* ---------- Setup ---------- */
  $$(".lang").forEach((b) => b.addEventListener("click", () => {
    state.lang = b.dataset.lang;
    $$(".lang").forEach((x) => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", x === b); });
    store.set("ke_lang", state.lang);
  }));
  $$(".tchip").forEach((b) => b.addEventListener("click", () => {
    state.target = Number(b.dataset.target);
    $$(".tchip").forEach((x) => x.classList.toggle("selected", x === b));
  }));

  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#nameInput");
    const name = input.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (state.players.length >= MAX_PLAYERS) { setupHint("That's the max — 10 singers"); return; }
    if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) { setupHint(name + " is already in"); return; }
    state.players.push({ name, score: 0 });
    input.value = "";
    renderChips();
    input.focus();
  });

  function setupHint(msg) { $("#setupHint").textContent = msg; }

  function renderChips() {
    const wrap = $("#chips");
    wrap.innerHTML = "";
    state.players.forEach((p, i) => {
      const c = document.createElement("button");
      c.className = "chip";
      c.type = "button";
      c.setAttribute("aria-label", "Remove " + p.name);
      c.innerHTML = '<span></span><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      c.firstChild.textContent = p.name;
      c.addEventListener("click", () => { state.players.splice(i, 1); renderChips(); });
      wrap.appendChild(c);
    });
    const n = state.players.length;
    $("#playerCount").textContent = n + " of " + MAX_PLAYERS;
    $("#startGame").disabled = n < 2;
    setupHint(n === 0 ? "Add at least 2 singers" : n === 1 ? "Add 1 more singer" : n >= MAX_PLAYERS ? "Full house! Tap a name to remove it" : "Tap a name to remove it");
  }

  $("#goSetup").addEventListener("click", () => { store.set("ke_seen", "1"); show("setup"); });
  $("#startGame").addEventListener("click", startGame);

  /* ---------- Game ---------- */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function startGame() {
    if (state.players.length < 2) return;
    state.players.forEach((p) => (p.score = 0));
    state.deck = shuffle((window.WORDS && window.WORDS[state.lang] ? window.WORDS[state.lang] : []).slice());
    state.wordNo = 0;
    state.over = false;
    state.startedAt = Date.now();
    $("#boardMeta").textContent = "First to " + state.target;
    $("#s-play").classList.toggle("crowd", state.players.length > 6);
    play("start");
    show("play");
    nextWord();
    logStart();
  }

  function nextWord() {
    if (!state.deck.length) state.deck = shuffle(window.WORDS[state.lang].filter((w) => w !== state.word));
    state.word = state.deck.pop();
    state.wordNo += 1;
    state.scoredIdx = null;
    const card = $("#wordCard");
    $("#word").textContent = state.word;
    fitWord();
    card.classList.remove("flip"); void card.offsetWidth; card.classList.add("flip");
    $("#wordCount").textContent = "WORD " + state.wordNo + " · " + state.lang.toUpperCase();
    renderRound();
    logUpdate({ wordsRevealed: state.wordNo });
  }

  function fitWord() {
    const el = $("#word");
    let size = 74;
    el.style.whiteSpace = "nowrap";
    el.style.fontSize = size + "px";
    // shrink long words until they fit the card on one line, never break mid-word
    while (size > 30 && el.scrollWidth > 290) {
      size -= 2;
      el.style.fontSize = size + "px";
    }
  }

  function ranks() {
    // competition ranking: 1, 2, 2, 4
    return state.players.map((p) => 1 + state.players.filter((q) => q.score > p.score).length);
  }

  function ordinal(n) { return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : n + "TH"; }

  function renderTiles() {
    const wrap = $("#tiles");
    const r = ranks();
    const anyScore = state.players.some((p) => p.score > 0);
    wrap.innerHTML = "";
    state.players.forEach((p, i) => {
      const t = document.createElement("button");
      t.className = "tile";
      t.type = "button";
      const leader = anyScore && r[i] === 1;
      if (leader) t.classList.add("leader");
      if (state.scoredIdx === i) t.classList.add("scored");
      const rankText = state.scoredIdx === i ? "+10!" : p.score > 0 ? (leader ? "♛ 1ST" : ordinal(r[i])) : "";
      t.innerHTML = '<span class="who"><span class="rank"></span><span class="name"></span></span><span class="pts"></span>';
      t.querySelector(".rank").textContent = rankText || " ";
      t.querySelector(".name").textContent = p.name;
      t.querySelector(".pts").textContent = p.score;
      t.setAttribute("aria-label", p.name + ", " + p.score + " points");
      t.addEventListener("click", () => award(i));
      wrap.appendChild(t);
    });
  }

  function renderRound() {
    const done = state.scoredIdx !== null;
    $("#s-play").classList.toggle("done", done);
    $("#skip").hidden = done;
    $("#nextRow").hidden = !done;
    if (done) {
      const p = state.players[state.scoredIdx];
      const left = state.target - p.score;
      $("#boardTitle").textContent = p.name + " got it!";
      $("#boardMeta").textContent = left > 0 ? left + " to win" : "Winner!";
      $("#boardHint").textContent = "Wrong person? Tap Undo";
    } else {
      $("#boardTitle").textContent = "Who sang it first?";
      $("#boardMeta").textContent = "First to " + state.target;
      $("#boardHint").textContent = "Tap a name to give them +" + POINTS;
    }
    renderTiles();
  }

  function award(i) {
    if (state.over || state.scoredIdx !== null) return;
    state.scoredIdx = i;
    state.players[i].score += POINTS;
    play("success");
    renderRound();
    if (state.players[i].score >= state.target) {
      state.over = true;
      $("#undo").disabled = true;
      $("#next").disabled = true;
      setTimeout(() => showWinner(i), 1200);
    }
  }

  $("#undo").addEventListener("click", () => {
    if (state.scoredIdx === null || state.over) return;
    state.players[state.scoredIdx].score -= POINTS;
    state.scoredIdx = null;
    renderRound();
  });
  $("#next").addEventListener("click", () => { if (!state.over) nextWord(); });
  $("#skip").addEventListener("click", () => { if (!state.over) nextWord(); });

  /* ---------- Winner ---------- */
  function showWinner(i) {
    const w = state.players[i];
    $("#winnerName").textContent = w.name + "!";
    let k;
    do { k = Math.floor(Math.random() * TROPHY_LINES.length); } while (k === state.lastTrophy && TROPHY_LINES.length > 1);
    state.lastTrophy = k;
    $("#trophyText").textContent = TROPHY_LINES[k];

    const r = ranks();
    const order = state.players.map((p, idx) => ({ p, r: r[idx], idx })).sort((a, b) => a.r - b.r || a.idx - b.idx);
    const list = $("#standings");
    list.innerHTML = "";
    order.slice(0, 8).forEach(({ p, r }) => {
      const li = document.createElement("li");
      if (r === 1) li.className = "first";
      li.innerHTML = '<span class="place"></span><span class="n"></span><span class="p"></span>';
      li.querySelector(".place").textContent = ordinal(r).toLowerCase();
      li.querySelector(".n").textContent = p.name;
      li.querySelector(".p").textContent = p.score;
      list.appendChild(li);
    });
    $("#undo").disabled = false;
    $("#next").disabled = false;
    show("winner");
    play("success");
    confetti();
    logEnd();
  }

  $("#playAgain").addEventListener("click", startGame);
  $("#newPlayers").addEventListener("click", () => { state.players = []; renderChips(); show("setup"); });

  function confetti() {
    const box = $("#confetti");
    const colors = ["#DD90BE", "#088846", "#F2E9DB", "#F16022"];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement("span");
      c.className = "confetti";
      c.style.left = Math.random() * 390 + "px";
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 0.6 + "s";
      c.style.animationDuration = 1.2 + Math.random() * 0.9 + "s";
      box.appendChild(c);
      setTimeout(() => c.remove(), 3000);
    }
  }

  /* ---------- Menu & rules ---------- */
  const menu = $("#menu"), rules = $("#rules");
  let endArmed = false;
  function resetEnd() { endArmed = false; $("#endLabel").textContent = "End game"; }
  $(".menu-btn").addEventListener("click", () => { resetEnd(); menu.hidden = false; });
  menu.addEventListener("click", (e) => { if (e.target === menu) menu.hidden = true; });
  rules.addEventListener("click", (e) => { if (e.target === rules) rules.hidden = true; });
  $$("[data-rules]").forEach((b) => b.addEventListener("click", () => { menu.hidden = true; rules.hidden = false; }));
  $("#closeRules").addEventListener("click", () => (rules.hidden = true));
  $("#soundRow").addEventListener("click", () => {
    state.sound = !state.sound;
    $("#soundSwitch").classList.toggle("on", state.sound);
    store.set("ke_sound", state.sound ? "1" : "0");
  });
  $("#endGame").addEventListener("click", () => {
    if (!endArmed) { endArmed = true; $("#endLabel").textContent = "Tap again to end game"; return; }
    menu.hidden = true;
    resetEnd();
    logEnd();
    state.over = true;
    state.players.forEach((p) => (p.score = 0));
    renderChips();
    show("welcome");
  });

  /* ---------- Firebase logging (optional, never blocks play) ---------- */
  let fb = null;
  async function firebase() {
    if (fb) return fb;
    const { db } = await import("./firebase-init.js");
    const m = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    fb = { db, ...m };
    return fb;
  }
  async function logStart() {
    state.session = null;
    try {
      const f = await firebase();
      state.session = await f.addDoc(f.collection(f.db, "sessions"), {
        startedAt: f.serverTimestamp(),
        playerCount: state.players.length,
        playerNames: state.players.map((p) => p.name),
        language: state.lang,
        target: state.target,
        wordsRevealed: 1,
        durationSeconds: null,
        finalScores: null,
      });
    } catch (e) { /* offline or blocked — game carries on */ }
  }
  async function logUpdate(data) {
    try { if (!state.session) return; const f = await firebase(); await f.updateDoc(state.session, data); } catch (e) {}
  }
  function logEnd() {
    if (!state.session) return;
    const scores = {};
    state.players.forEach((p) => (scores[p.name] = p.score));
    logUpdate({ wordsRevealed: state.wordNo, durationSeconds: Math.round((Date.now() - state.startedAt) / 1000), finalScores: scores });
    state.session = null;
  }

  /* ---------- Boot ---------- */
  const savedLang = store.get("ke_lang");
  if (savedLang === "english" || savedLang === "hindi") $$(".lang").find((b) => b.dataset.lang === savedLang).click();
  if (store.get("ke_sound") === "0") { state.sound = false; $("#soundSwitch").classList.remove("on"); }
  renderChips();
  if (store.get("ke_seen")) show("setup");
})();
