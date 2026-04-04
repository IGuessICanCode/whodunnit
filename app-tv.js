import { db } from "./firebase-init.js";
import {
  doc, setDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { PROMPT_PACKS } from "./prompts.js";

/* ============================================================
   CONSTANTS
   ============================================================ */
const MIN_PLAYERS   = 3;
const GUESSING_SECS = 45;
const VOTING_SECS   = 30;

// Colour palette for player avatars
const AVATAR_COLORS = [
  "#F16022","#DD90BE","#088846","#191348",
  "#711611","#162F19","#282828","#F16022"
];

/* ============================================================
   ROOM SETUP
   ============================================================ */
function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

const roomCode = generateCode();
const roomRef  = doc(db, "rooms", roomCode);

await setDoc(roomRef, {
  state:                   "LOBBY",
  players:                 {},
  promptPack:              "core",
  promptIndex:             0,
  prompt:                  "",
  guesses:                 {},
  votes:                   {},
  revealScored:            false,
  roundPlayerIds:          [],
  scoreboardOrder:         [],
  previousScoreboardOrder: [],
  guessingDeadline:        0,
  votingDeadline:          0,
  gameEnded:               false,
});

/* ============================================================
   TIMER MANAGEMENT
   ============================================================ */
const timers = { interval: null, timeout: null };

function clearTimers() {
  if (timers.interval) clearInterval(timers.interval);
  if (timers.timeout)  clearTimeout(timers.timeout);
  timers.interval = null;
  timers.timeout  = null;
}

function startTimer(deadline, onEnd) {
  clearTimers();
  const total = deadline - Date.now();
  if (total <= 0) { onEnd(); return; }

  const update = () => {
    const remaining = Math.max(0, deadline - Date.now());
    const secs      = Math.ceil(remaining / 1000);
    const el        = document.getElementById("timer-label");
    const bar       = document.getElementById("timer-bar");
    if (el)  el.textContent = secs + "s";
    if (bar) bar.style.width = (remaining / total * 100) + "%";
    if (remaining <= 0) clearTimers();
  };

  timers.interval = setInterval(update, 200);
  timers.timeout  = setTimeout(() => { clearTimers(); onEnd(); }, total);
  update();
}

/* ============================================================
   HELPER: AVATAR COLOR
   ============================================================ */
function avatarColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase();
}

/* ============================================================
   STATE ROUTER
   ============================================================ */
let lastState = null;
let lastRevealScored = false;

onSnapshot(roomRef, snap => {
  const data = snap.data();
  if (!data) return;

  const stateChanged        = data.state !== lastState;
  const revealScoredChanged = data.revealScored !== lastRevealScored;
  lastState        = data.state;
  lastRevealScored = data.revealScored;

  if (stateChanged) clearTimers();

  renderFooter();

  switch (data.state) {
    case "LOBBY":      renderLobby(data);                                          break;
    case "PROMPT":     if (stateChanged) renderPrompt(data);                       break;
    case "GUESSING":   renderGuessing(data, stateChanged);                         break;
    case "VOTING":     renderVoting(data, stateChanged);                           break;
    case "REVEAL":     if (stateChanged || revealScoredChanged) renderReveal(data); break;
    case "SCOREBOARD": if (stateChanged) renderScoreboard(data);                   break;
  }
});

/* ============================================================
   FOOTER
   ============================================================ */
function renderFooter() {
  const f = document.getElementById("game-footer");
  if (!f) return;
  f.innerHTML = `Join at <strong>${window.location.host}/phone.html</strong>
    &nbsp;·&nbsp; Code: <strong>${roomCode}</strong>`;
}

/* ============================================================
   LOBBY
   ============================================================ */
function renderLobby(data) {
  const players  = data.players || {};
  const ids      = Object.keys(players);
  const canStart = ids.length >= MIN_PLAYERS;
  const packs    = PROMPT_PACKS;

  const phoneURL = `${window.location.origin}/phone.html?room=${roomCode}`;

  document.getElementById("app").innerHTML = `
    <div class="lobby-layout fade-up">

      <!-- LEFT -->
      <div class="lobby-left">
        <h1>WHO<span>DUNNIT</span></h1>
        <p class="tagline">Guess who in the room has done it 👀</p>

        <div class="player-list" id="player-list">
          ${ids.length === 0
            ? `<span class="empty-hint">Waiting for players to join…</span>`
            : ids.map(id => `
              <div class="lobby-player">
                <div class="av" style="background:${avatarColor(id)};color:#000">
                  ${initials(players[id].name)}
                </div>
                ${players[id].name}
              </div>`).join("")
          }
        </div>

        <!-- Pack selector -->
        <div class="pack-row" id="pack-row">
          ${Object.entries(packs).map(([key, pack]) => `
            <button class="pack-btn ${key === data.promptPack ? "active" : ""}"
              data-pack="${key}">
              ${pack.emoji} ${pack.label}
            </button>
          `).join("")}
        </div>

        <br/>

        <button class="btn btn-primary" id="start-btn" ${!canStart ? "disabled" : ""}>
          ${canStart ? "▶ START GAME" : `Need ${MIN_PLAYERS - ids.length} more player${MIN_PLAYERS - ids.length !== 1 ? "s" : ""}`}
        </button>
      </div>

      <!-- RIGHT: QR + Code -->
      <div class="lobby-right">
        <div class="qr-card">
          <div id="qr-code"></div>
        </div>
        <div class="room-code-display">
          <div class="label">Room Code</div>
          <div class="code">${roomCode}</div>
        </div>
      </div>

    </div>
  `;

  // Generate QR
  new QRCode(document.getElementById("qr-code"), {
    text: phoneURL,
    width: 200,
    height: 200,
    colorDark: "#000000",
    colorLight: "#ffffff",
  });

  // Pack buttons
  document.getElementById("pack-row").addEventListener("click", e => {
    const btn = e.target.closest(".pack-btn");
    if (!btn) return;
    updateDoc(roomRef, { promptPack: btn.dataset.pack });
  });

  // Start
  document.getElementById("start-btn").onclick = async () => {
    if (!canStart) return;
    const pack   = PROMPT_PACKS[data.promptPack];
    const prompt = pack.prompts[data.promptIndex % pack.prompts.length];

    await updateDoc(roomRef, {
      state:          "PROMPT",
      prompt,
      guesses:        {},
      votes:          {},
      revealScored:   false,
      roundPlayerIds: ids,
    });
  };
}

/* ============================================================
   PROMPT (auto-advance after 3s)
   ============================================================ */
function renderPrompt(data) {
  const pack = PROMPT_PACKS[data.promptPack];

  document.getElementById("app").innerHTML = `
    <div class="prompt-screen fade-up">
      <span class="prompt-chip">${pack.emoji} ${pack.label}</span>
      <div class="prompt-text display">${data.prompt}</div>
      <div class="countdown-ring" id="prompt-countdown">3</div>
    </div>
  `;

  let n = 3;
  const el = document.getElementById("prompt-countdown");
  const iv = setInterval(() => {
    n--;
    if (el) el.textContent = n;
    if (n <= 0) {
      clearInterval(iv);
      const deadline = Date.now() + GUESSING_SECS * 1000;
      updateDoc(roomRef, { state: "GUESSING", guessingDeadline: deadline });
    }
  }, 1000);
}

/* ============================================================
   GUESSING
   ============================================================ */
function renderGuessing(data, stateChanged) {
  const { roundPlayerIds: ids, players, guesses = {}, guessingDeadline } = data;

  const done    = ids.filter(id => guesses[id] !== undefined);
  const waiting = ids.filter(id => guesses[id] === undefined);

  if (stateChanged) {
    document.getElementById("app").innerHTML = `
      <div class="round-screen fade-up">
        <div class="round-prompt">${data.prompt}</div>

        <div>
          <p style="font-size:1rem;color:var(--text-muted);margin-bottom:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
            Guess how many people have done this 👇
          </p>
          <div class="player-grid" id="player-grid"></div>
        </div>

        <div class="round-footer">
          <div class="timer-wrap" style="flex:1"><div class="timer-bar" id="timer-bar" style="width:100%"></div></div>
          <span class="timer-label" id="timer-label">${GUESSING_SECS}s</span>
          <button class="btn btn-outline" id="force-btn">Skip →</button>
          <button class="btn btn-outline" id="end-btn">End Game</button>
        </div>
      </div>
    `;

    startTimer(guessingDeadline, () => updateDoc(roomRef, { state: "VOTING", votingDeadline: Date.now() + VOTING_SECS * 1000 }));

    document.getElementById("force-btn").onclick = () =>
      updateDoc(roomRef, { state: "VOTING", votingDeadline: Date.now() + VOTING_SECS * 1000 });

    document.getElementById("end-btn").onclick = () =>
      updateDoc(roomRef, { state: "SCOREBOARD", gameEnded: true });
  }

  // Update player grid (on every snapshot)
  const grid = document.getElementById("player-grid");
  if (!grid) return;
  grid.innerHTML = [
    ...done.map(id    => playerChip(players[id].name, id, true)),
    ...waiting.map(id => playerChip(players[id].name, id, false)),
  ].join("");

  // Auto-advance when everyone is done
  if (done.length === ids.length && ids.length > 0) {
    updateDoc(roomRef, { state: "VOTING", votingDeadline: Date.now() + VOTING_SECS * 1000 });
  }
}

/* ============================================================
   VOTING
   ============================================================ */
function renderVoting(data, stateChanged) {
  const { roundPlayerIds: ids, players, votes = {}, votingDeadline } = data;

  const voted   = ids.filter(id => votes[id] !== undefined);
  const waiting = ids.filter(id => votes[id] === undefined);

  if (stateChanged) {
    document.getElementById("app").innerHTML = `
      <div class="round-screen fade-up">
        <div class="round-prompt">${data.prompt}</div>

        <div>
          <p style="font-size:1rem;color:var(--text-muted);margin-bottom:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">
            Confess on your phone — have YOU done this? 🤫
          </p>
          <div class="player-grid" id="player-grid"></div>
        </div>

        <div class="round-footer">
          <div class="timer-wrap" style="flex:1"><div class="timer-bar" id="timer-bar" style="width:100%"></div></div>
          <span class="timer-label" id="timer-label">${VOTING_SECS}s</span>
          <button class="btn btn-outline" id="force-btn">Reveal →</button>
          <button class="btn btn-outline" id="end-btn">End Game</button>
        </div>
      </div>
    `;

    startTimer(votingDeadline, () => updateDoc(roomRef, { state: "REVEAL" }));

    document.getElementById("force-btn").onclick = () =>
      updateDoc(roomRef, { state: "REVEAL" });

    document.getElementById("end-btn").onclick = () =>
      updateDoc(roomRef, { state: "SCOREBOARD", gameEnded: true });
  }

  const grid = document.getElementById("player-grid");
  if (!grid) return;
  grid.innerHTML = [
    ...voted.map(id   => playerChip(players[id].name, id, true)),
    ...waiting.map(id => playerChip(players[id].name, id, false)),
  ].join("");

  if (voted.length === ids.length && ids.length > 0) {
    updateDoc(roomRef, { state: "REVEAL" });
  }
}

/* ============================================================
   REVEAL
   ============================================================ */
function renderReveal(data) {
  const { roundPlayerIds: ids, players, guesses = {}, votes = {} } = data;

  // Count actual yes votes
  const actual = ids.filter(id => votes[id] === true).length;

  // Score players (only once)
  if (!data.revealScored) {
    const updatedPlayers = { ...players };
    const deltas = {};

    ids.forEach(id => {
      const guess = guesses[id] ?? -1;
      const diff  = Math.abs(guess - actual);
      let pts = 0;
      if (diff === 0) pts = 500;
      else if (diff === 1) pts = 250;
      else if (diff === 2) pts = 100;
      deltas[id] = pts;
      updatedPlayers[id] = {
        ...updatedPlayers[id],
        score: (updatedPlayers[id].score || 0) + pts,
      };
    });

    const prev = data.scoreboardOrder.length
      ? data.scoreboardOrder
      : ids;

    const next = [...ids].sort(
      (a, b) => (updatedPlayers[b].score || 0) - (updatedPlayers[a].score || 0)
    );

    updateDoc(roomRef, {
      players:                 updatedPlayers,
      revealScored:            true,
      previousScoreboardOrder: prev,
      scoreboardOrder:         next,
      revealDeltas:            deltas,
    });

    // Confetti!
    confetti({ particleCount: 120, spread: 90, origin: { y: 0.5 } });
    return; // will re-render once revealScored updates
  }

  const deltas = data.revealDeltas || {};

  document.getElementById("app").innerHTML = `
    <div class="reveal-screen fade-up">
      <div class="reveal-prompt">"${data.prompt}"</div>

      <div class="reveal-number pop-in">${actual}</div>
      <div class="reveal-label">${actual === 1 ? "person has" : "people have"} done this</div>

      <div class="score-deltas">
        ${ids.map((id, i) => {
          const pts   = deltas[id] || 0;
          const guess = guesses[id] ?? "?";
          const cls   = pts === 500 ? "got-it" : pts > 0 ? "close" : "miss";
          const icon  = pts === 500 ? "🎯" : pts > 0 ? "👍" : "😬";
          return `<div class="delta-chip ${cls}" style="animation-delay:${i * 0.08}s">
            ${icon} ${players[id].name} guessed ${guess} → +${pts}
          </div>`;
        }).join("")}
      </div>

      <button class="btn btn-primary" id="scores-btn">See Scores →</button>
    </div>
  `;

  document.getElementById("scores-btn").onclick = () =>
    updateDoc(roomRef, { state: "SCOREBOARD" });
}

/* ============================================================
   SCOREBOARD
   ============================================================ */
function renderScoreboard(data) {
  const { players, scoreboardOrder: curr, previousScoreboardOrder: prev, gameEnded } = data;
  const deltas = data.revealDeltas || {};

  if (gameEnded) {
    renderGameOver(data);
    return;
  }

  document.getElementById("app").innerHTML = `
    <div class="scoreboard-screen fade-up">
      <div class="scoreboard-title">
        🏆 <span>Scoreboard</span>
        <span style="font-size:1rem;color:var(--text-muted);margin-left:8px">
          Round ${data.promptIndex + 1}
        </span>
      </div>

      <div class="score-list" id="score-list">
        ${curr.map((id, i) => {
          const medals = ["🥇","🥈","🥉"];
          const medal  = medals[i] || `${i+1}.`;
          return `
          <div class="score-row" data-id="${id}">
            <span class="rank rank-medal">${medal}</span>
            <span class="name">${players[id].name}</span>
            <span class="delta">+${deltas[id] || 0}</span>
            <span class="pts">${players[id].score || 0}</span>
          </div>`;
        }).join("")}
      </div>

      <div class="scoreboard-footer">
        <button class="btn btn-outline" id="end-btn">End Game</button>
        <button class="btn btn-primary" id="next-btn">Next Round →</button>
      </div>
    </div>
  `;

  // Animate rows sliding into position
  document.querySelectorAll(".score-row").forEach(row => {
    const id       = row.dataset.id;
    const prevIdx  = prev.indexOf(id);
    const currIdx  = curr.indexOf(id);
    if (prevIdx === -1) return;
    const delta = (prevIdx - currIdx) * (row.offsetHeight + 10);
    row.style.transform = `translateY(${delta}px)`;
    row.offsetHeight; // force reflow
    row.style.transition = "transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)";
    row.style.transform  = "translateY(0)";
  });

  document.getElementById("end-btn").onclick = () =>
    updateDoc(roomRef, { state: "SCOREBOARD", gameEnded: true });

  document.getElementById("next-btn").onclick = async () => {
    const pack       = PROMPT_PACKS[data.promptPack];
    const nextIndex  = (data.promptIndex + 1) % pack.prompts.length;
    const nextPrompt = pack.prompts[nextIndex];

    await updateDoc(roomRef, {
      state:          "PROMPT",
      promptIndex:    nextIndex,
      prompt:         nextPrompt,
      guesses:        {},
      votes:          {},
      revealScored:   false,
      revealDeltas:   {},
      roundPlayerIds: Object.keys(players),
    });
  };
}

/* ============================================================
   GAME OVER
   ============================================================ */
function renderGameOver(data) {
  const { players, scoreboardOrder: order } = data;
  const winner = order[0] ? players[order[0]] : null;

  confetti({ particleCount: 200, spread: 120, origin: { y: 0.4 } });

  document.getElementById("app").innerHTML = `
    <div class="gameover-screen fade-up">
      <div class="gameover-title">GAME OVER!</div>

      ${winner ? `
        <div class="winner-badge">
          <div class="w-label">🏆 Winner</div>
          <div class="w-name">${winner.name}</div>
          <div class="w-pts">${winner.score} pts</div>
        </div>` : ""}

      <div class="final-scores">
        ${order.map((id, i) => `
          <div class="score-row">
            <span class="rank">${["🥇","🥈","🥉"][i] || (i+1)+"."}</span>
            <span class="name">${players[id].name}</span>
            <span class="pts">${players[id].score || 0}</span>
          </div>`).join("")}
      </div>

      <button class="btn btn-primary" onclick="window.location.reload()">Play Again</button>
    </div>
  `;
}

/* ============================================================
   HELPERS
   ============================================================ */
function playerChip(name, id, done) {
  const color = avatarColor(id);
  const cls   = done ? "done" : "waiting";
  const icon  = done ? "✓" : "⏳";
  return `
    <div class="player-chip ${cls}">
      <div class="avatar" style="background:${color};color:#000">${initials(name)}</div>
      ${name} ${icon}
    </div>`;
}
