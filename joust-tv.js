import { db } from "./firebase-init.js";
import {
  doc, setDoc, updateDoc, onSnapshot, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   ROOM SETUP
   ============================================================ */
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const roomCode = genCode();
const roomRef  = doc(db, "sessions", roomCode);
const phoneURL = `${window.location.origin}/joust-phone.html?room=${roomCode}`;

await setDoc(roomRef, {
  state:      "LOBBY",
  players:    {},
  tempoFast:  false,
  graceUntil: 0,
  winnerId:   null,
  gameStart:  0,
});

/* ============================================================
   MUSIC ENGINE
   ============================================================ */
let audioCtx = null;
let schedulerTimer = null;
let noteIndex  = 0;
let nextNoteAt = 0;
let bpm        = 60;
let musicOn    = false;

// G major pentatonic arpeggio — two 8-bar phrases
const MELODY = [
  392.00, 493.88, 587.33, 783.99,  // G4 B4 D5 G5
  587.33, 493.88, 392.00, 293.66,  // D5 B4 G4 D4
  392.00, 493.88, 587.33, 783.99,
  440.00, 493.88, 587.33, 523.25,  // A4 B4 D5 C5
];

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playNote(freq, when, dur) {
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "triangle";
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0.12, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + Math.min(dur * 0.9, 0.35));

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + dur);
}

function scheduleMusic() {
  if (!musicOn) return;
  ensureAudio();

  const beatLen  = 60 / bpm;
  const lookAhead = 0.3; // seconds

  while (nextNoteAt < audioCtx.currentTime + lookAhead) {
    playNote(MELODY[noteIndex % MELODY.length], Math.max(nextNoteAt, audioCtx.currentTime + 0.01), beatLen * 0.85);
    nextNoteAt += beatLen;
    noteIndex++;
  }

  schedulerTimer = setTimeout(scheduleMusic, 50);
}

function startMusic() {
  ensureAudio();
  musicOn    = true;
  bpm        = 60;
  nextNoteAt = audioCtx.currentTime + 0.1;
  noteIndex  = 0;
  scheduleMusic();
}

function stopMusic() {
  musicOn = false;
  clearTimeout(schedulerTimer);
}

function setTempo(fast) {
  bpm = fast ? 190 : 60;
}

/* ============================================================
   TEMPO SCHEDULER — random bursts while PLAYING
   ============================================================ */
let tempoTimer  = null;
let burstActive = false;

function startTempoLoop() {
  scheduleNextBurst();
}

function stopTempoLoop() {
  clearTimeout(tempoTimer);
  tempoTimer  = null;
  burstActive = false;
}

function scheduleNextBurst() {
  const wait = 10000 + Math.random() * 14000; // 10–24 s between bursts
  tempoTimer = setTimeout(triggerBurst, wait);
}

async function triggerBurst() {
  if (!musicOn) return;
  burstActive = true;
  setTempo(true);
  await updateDoc(roomRef, { tempoFast: true });

  const dur = 3000 + Math.random() * 3000; // 3–6 s burst
  tempoTimer = setTimeout(async () => {
    burstActive = false;
    setTempo(false);
    await updateDoc(roomRef, { tempoFast: false });
    scheduleNextBurst();
  }, dur);
}

/* ============================================================
   WINNER DETECTION
   ============================================================ */
let winnerDetected = false;

function checkWinner(players) {
  if (winnerDetected) return;
  const ids   = Object.keys(players);
  if (ids.length < 2) return;

  const alive = ids.filter(id => players[id].alive);
  if (alive.length <= 1) {
    winnerDetected = true;
    const winnerId = alive[0] ?? null;
    stopMusic();
    stopTempoLoop();
    updateDoc(roomRef, { state: "WINNER", winnerId, tempoFast: false });
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function initials(name) {
  return name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase();
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className   = "toast";
  t.textContent = msg;
  document.getElementById("toast-root").appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ============================================================
   STATE ROUTER
   ============================================================ */
const tvApp    = document.getElementById("tv-app");
let lastState  = null;
let lastTempoFast = false;
let prevPlayerIds = new Set();

onSnapshot(roomRef, snap => {
  const d = snap.data();
  if (!d) return;

  const stateChanged = d.state !== lastState;
  lastState = d.state;

  // Toast when new player joins
  const curIds = new Set(Object.keys(d.players || {}));
  if (prevPlayerIds.size > 0 && d.state === "LOBBY") {
    for (const id of curIds) {
      if (!prevPlayerIds.has(id)) showToast(`${d.players[id].name} joined!`);
    }
  }
  prevPlayerIds = curIds;

  if (d.state === "PLAYING") {
    if (d.tempoFast !== lastTempoFast) {
      lastTempoFast = d.tempoFast;
      updatePlayingTempoUI(d.tempoFast, d.players);
    }
    if (stateChanged) {
      renderPlaying(d);
    } else {
      updatePlayerCards(d.players, d.tempoFast);
      checkWinner(d.players || {});
    }
    return;
  }

  switch (d.state) {
    case "LOBBY":      renderLobby(d);      break;
    case "COUNTDOWN":  if (stateChanged) renderCountdown(d); break;
    case "WINNER":     if (stateChanged) renderWinner(d);    break;
  }
});

/* ============================================================
   LOBBY
   ============================================================ */
function renderLobby(data) {
  winnerDetected = false;
  stopMusic();
  stopTempoLoop();

  const players  = data.players || {};
  const ids      = Object.keys(players);
  const canStart = ids.length >= 2;

  tvApp.innerHTML = `
    <div class="tv-lobby">
      <div>
        <h1>PHONE<br><em>JOUST</em></h1>
        <p class="tv-tagline">
          Hold your phone still.<br>
          Last one standing wins.
        </p>

        <div class="tv-plist" id="plist">
          ${ids.length === 0
            ? `<span class="tv-hint">Waiting for players to scan…</span>`
            : ids.map(id => `
              <div class="tv-pentry">
                <div class="tv-av" style="background:${players[id].color}">
                  ${initials(players[id].name)}
                </div>
                ${players[id].name}
              </div>`).join("")}
        </div>

        <button class="tv-start" id="start-btn" ${canStart ? "" : "disabled"}>
          ${canStart
            ? "▶  START GAME"
            : `Need ${2 - ids.length} more player${ids.length === 1 ? "" : "s"}`}
        </button>
      </div>

      <div class="lobby-right">
        <div class="qr-box" id="qr-el"></div>
        <div class="code-box">
          <div class="code-label">Room Code</div>
          <div class="code-value">${roomCode}</div>
        </div>
        <div class="join-url">${window.location.host}/joust-phone.html</div>
      </div>
    </div>
  `;

  new QRCode(document.getElementById("qr-el"), {
    text: phoneURL, width: 200, height: 200,
    colorDark: "#000000", colorLight: "#ffffff",
  });

  document.getElementById("start-btn").onclick = () => {
    if (!canStart) return;
    ensureAudio(); // must be from user gesture
    const gameStart = Date.now() + 3200;
    updateDoc(roomRef, {
      state:      "COUNTDOWN",
      gameStart,
      graceUntil: gameStart,
      tempoFast:  false,
      winnerId:   null,
      // reset alive for all players
      ...Object.fromEntries(
        Object.keys(data.players).map(id => [`players.${id}.alive`, true])
      ),
    });

    // Auto-advance to PLAYING after countdown
    setTimeout(() => {
      updateDoc(roomRef, { state: "PLAYING" });
      startMusic();
      startTempoLoop();
    }, 3200);
  };
}

/* ============================================================
   COUNTDOWN (TV side — just display, phones do their own countdown)
   ============================================================ */
let cdIv = null;

function renderCountdown(data) {
  clearInterval(cdIv);
  const startAt = data.gameStart || (Date.now() + 3000);

  function tick() {
    const rem = Math.ceil((startAt - Date.now()) / 1000);
    if (rem <= 0) { clearInterval(cdIv); return; }
    tvApp.innerHTML = `
      <div class="tv-countdown">
        <div class="tv-count-num">${rem}</div>
        <div class="tv-count-label">Get ready — hold still!</div>
      </div>
    `;
  }

  tick();
  cdIv = setInterval(tick, 300);
}

/* ============================================================
   PLAYING
   ============================================================ */
function renderPlaying(data) {
  const players = data.players || {};
  const ids     = Object.keys(players);

  tvApp.innerHTML = `
    <div class="tv-playing">
      <div class="tv-play-header">
        <div class="tv-play-title">PHONE <em>JOUST</em></div>
        <div id="tempo-pill" class="tempo-pill slow">🎵 Stay Still</div>
        <div class="tv-alive-count" id="alive-count"></div>
      </div>

      <div class="tv-grid" id="tv-grid">
        ${ids.map(id => playerCard(id, players[id], data.tempoFast)).join("")}
      </div>

      <button class="tv-end-btn" id="end-btn">End Game</button>
    </div>
  `;

  updateAliveCount(players);

  document.getElementById("end-btn").onclick = () => {
    stopMusic(); stopTempoLoop();
    updateDoc(roomRef, { state: "LOBBY" });
  };
}

function playerCard(id, p, fast) {
  const cls = p.alive ? (fast ? "alive fast-mode" : "alive") : "dead";
  return `
    <div class="tv-card ${cls}" id="card-${id}">
      <div class="card-av" style="background:${p.color}">${initials(p.name)}</div>
      <div class="card-name">${p.name}</div>
      <div class="card-status ${p.alive ? "alive" : "dead"}">${p.alive ? "ALIVE" : "OUT"}</div>
    </div>`;
}

function updatePlayerCards(players, fast) {
  for (const [id, p] of Object.entries(players)) {
    const el = document.getElementById(`card-${id}`);
    if (!el) continue;
    const cls = p.alive ? (fast ? "alive fast-mode" : "alive") : "dead";
    el.className = `tv-card ${cls}`;
    el.querySelector(".card-status").className  = `card-status ${p.alive ? "alive" : "dead"}`;
    el.querySelector(".card-status").textContent = p.alive ? "ALIVE" : "OUT";
  }
  updateAliveCount(players);
}

function updateAliveCount(players) {
  const el    = document.getElementById("alive-count");
  const alive = Object.values(players).filter(p => p.alive).length;
  const total = Object.keys(players).length;
  if (el) el.textContent = `${alive} / ${total} alive`;
}

function updatePlayingTempoUI(fast, players) {
  const pill = document.getElementById("tempo-pill");
  if (pill) {
    pill.className   = `tempo-pill ${fast ? "fast" : "slow"}`;
    pill.textContent = fast ? "⚡ DASH NOW ⚡" : "🎵 Stay Still";
  }
  if (players) updatePlayerCards(players, fast);
}

/* ============================================================
   WINNER
   ============================================================ */
function renderWinner(data) {
  stopMusic(); stopTempoLoop();

  const winner = data.winnerId ? data.players?.[data.winnerId] : null;

  confetti({ particleCount: 180, spread: 100, origin: { y: 0.45 } });
  setTimeout(() => confetti({ particleCount: 100, spread: 80, origin: { x: 0.1, y: 0.5 } }), 400);
  setTimeout(() => confetti({ particleCount: 100, spread: 80, origin: { x: 0.9, y: 0.5 } }), 700);

  tvApp.innerHTML = `
    <div class="tv-winner">
      <div class="tv-winner-trophy">🏆</div>
      <div class="tv-winner-label">Last one standing</div>
      <div class="tv-winner-name">${winner ? winner.name : "Nobody?!"}</div>
      <button class="tv-replay" id="replay-btn">Play Again</button>
    </div>
  `;

  document.getElementById("replay-btn").onclick = () => {
    updateDoc(roomRef, {
      state:     "LOBBY",
      tempoFast: false,
      winnerId:  null,
    });
  };
}
