import { db } from "./firebase-init.js";
import {
  doc, getDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   CONSTANTS
   ============================================================ */
const THRESHOLD_SLOW = 2.8;   // m/s² — strict while music is slow
const THRESHOLD_FAST = 7.5;   // m/s² — relaxed during speed burst
const GRACE_MS       = 2500;  // ms after PLAYING starts before elimination possible
const GRAVITY_ALPHA  = 0.82;  // high-pass filter coefficient

const PLAYER_COLORS = [
  "#22ff7a","#ff6b35","#4fc3f7","#e040fb",
  "#ffca28","#ff4081","#69f0ae","#40c4ff",
];

/* ============================================================
   STATE
   ============================================================ */
const app    = document.getElementById("phone-app");
const pid    = sessionStorage.getItem("joust_pid") || crypto.randomUUID();
sessionStorage.setItem("joust_pid", pid);

const urlRoom = new URLSearchParams(window.location.search).get("room") || "";

let playerName    = "";
let roomRef       = null;
let unsub         = null;
let motionGranted = false;
let alive         = true;
let playingLive   = false;   // true once PLAYING screen is set up
let graceUntil    = 0;
let currentThreshold = THRESHOLD_SLOW;
let animFrame     = null;

// High-pass filter gravity state
let gx = 0, gy = 0, gz = 0;
let magnitude = 0;

renderJoin();

/* ============================================================
   JOIN SCREEN
   ============================================================ */
function renderJoin(err = "") {
  app.innerHTML = `
    <div class="p-join">
      <div class="p-logo">PHONE JOUST</div>
      <h2>Join Game 🎮</h2>
      <p>Enter the code shown on the TV</p>

      ${err ? `<div class="p-error">${err}</div>` : ""}

      <input class="p-input" id="room-in" placeholder="ROOM CODE"
        maxlength="4" value="${urlRoom}"
        autocapitalize="characters" autocomplete="off" spellcheck="false" />
      <input class="p-input" id="name-in" placeholder="Your name" maxlength="16" />

      <button class="p-btn" id="join-btn">Let's Joust →</button>
    </div>
  `;

  const roomIn = document.getElementById("room-in");
  const nameIn = document.getElementById("name-in");
  if (urlRoom) nameIn.focus(); else roomIn.focus();

  document.getElementById("join-btn").onclick = attemptJoin;
  app.addEventListener("keydown", e => { if (e.key === "Enter") attemptJoin(); }, { once: true });
}

async function attemptJoin() {
  const code = document.getElementById("room-in").value.trim().toUpperCase();
  const name = document.getElementById("name-in").value.trim();

  if (!code || code.length < 4) return renderJoin("Enter the 4-letter room code from the TV");
  if (!name)                     return renderJoin("Enter your name to join");

  const btn = document.getElementById("join-btn");
  btn.textContent = "Joining…"; btn.disabled = true;

  try {
    const ref  = doc(db, "sessions", code);
    const snap = await getDoc(ref);

    if (!snap.exists()) return renderJoin(`Room "${code}" not found. Check the TV!`);

    const data = snap.data();
    if (data.state === "WINNER") return renderJoin("That game just ended. Start a new one on the TV.");

    playerName = name;
    roomRef    = ref;

    const colorIdx = [...pid].reduce((a, c) => a + c.charCodeAt(0), 0) % PLAYER_COLORS.length;
    const color    = PLAYER_COLORS[colorIdx];

    await updateDoc(ref, {
      [`players.${pid}`]: { name, alive: true, color, joined: Date.now() }
    });

    listenRoom();
  } catch (e) {
    console.error(e);
    renderJoin("Something went wrong. Try again.");
  }
}

/* ============================================================
   ROOM LISTENER
   ============================================================ */
function listenRoom() {
  if (unsub) unsub();

  unsub = onSnapshot(roomRef, snap => {
    const d = snap.data();
    if (!d) return;

    switch (d.state) {
      case "LOBBY":
        playingLive = false;
        stopMotion();
        renderLobby(d);
        break;

      case "COUNTDOWN":
        playingLive = false;
        stopMotion();
        renderCountdown(d);
        break;

      case "PLAYING":
        // Check if this player was eliminated externally (host kicked, etc.)
        if (d.players?.[pid]?.alive === false) {
          if (alive) { alive = false; stopMotion(); }
          renderDead();
          return;
        }
        if (!playingLive) {
          playingLive = true;
          alive       = true;
          graceUntil  = (d.graceUntil || Date.now()) + GRACE_MS;
          startPlayingScreen(d);
        } else {
          // Update threshold from tempo changes
          currentThreshold = d.tempoFast ? THRESHOLD_FAST : THRESHOLD_SLOW;
          updatePlayingTempo(d.tempoFast);
        }
        break;

      case "WINNER":
        stopMotion();
        renderWinner(d);
        break;
    }
  });
}

/* ============================================================
   LOBBY SCREEN
   ============================================================ */
function renderLobby(data) {
  alive = true;
  app.innerHTML = `
    <div class="p-wait">
      <div class="p-logo">PHONE JOUST</div>
      <div class="big-em">🎮</div>
      <h2>You're in!</h2>
      <div class="p-name-tag">Playing as ${playerName}</div>
      <p>Waiting for the host to start…</p>

      ${!motionGranted
        ? `<button class="p-btn" id="motion-btn" style="margin-top:8px">
             📳 Activate Controller
           </button>
           <p style="font-size:0.8rem;color:#555;text-align:center">Required to detect movement</p>`
        : `<div class="p-ready-tag">✓ Controller active</div>`
      }

      <div class="dots"><span></span><span></span><span></span></div>
    </div>
  `;

  document.getElementById("motion-btn")?.addEventListener("click", activateMotion);
}

async function activateMotion() {
  if (typeof DeviceMotionEvent?.requestPermission === "function") {
    try {
      motionGranted = (await DeviceMotionEvent.requestPermission()) === "granted";
    } catch { motionGranted = false; }
  } else {
    // Android / non-iOS — permission not required
    motionGranted = true;
  }

  const btn = document.getElementById("motion-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = motionGranted ? "✓ Controller Active!" : "⚠️ Permission denied — go to Settings";
  }
}

/* ============================================================
   COUNTDOWN SCREEN
   ============================================================ */
let countIv = null;

function renderCountdown(data) {
  clearInterval(countIv);

  const startAt = data.gameStart || (Date.now() + 3000);

  function tick() {
    const rem = Math.ceil((startAt - Date.now()) / 1000);
    if (rem <= 0) { clearInterval(countIv); return; }
    app.innerHTML = `
      <div class="p-countdown">
        <div class="p-logo">PHONE JOUST</div>
        <div class="p-count-num">${rem}</div>
        <div class="p-count-sub">Get ready — HOLD STILL!</div>
      </div>
    `;
  }

  tick();
  countIv = setInterval(tick, 300);
}

/* ============================================================
   PLAYING SCREEN
   ============================================================ */
const R    = 92;
const CIRC = 2 * Math.PI * R;

function startPlayingScreen(data) {
  currentThreshold = data.tempoFast ? THRESHOLD_FAST : THRESHOLD_SLOW;

  app.innerHTML = `
    <div class="p-playing" id="playing-wrap">
      <div class="p-playing-name">${playerName}</div>

      <div class="p-ring-wrap">
        <svg width="220" height="220" viewBox="0 0 220 220">
          <circle class="ring-bg" cx="110" cy="110" r="${R}" />
          <circle class="ring-fg" id="ring-fg" cx="110" cy="110" r="${R}"
            style="stroke-dasharray:${CIRC};stroke-dashoffset:${CIRC};stroke:var(--alive);" />
        </svg>
        <div class="ring-icon" id="ring-icon">🛡️</div>
      </div>

      <div class="p-tempo-pill slow" id="tempo-pill">🎵 Stay Still</div>
    </div>
  `;

  startMotion();

  // rAF loop for smooth ring updates
  function animate() {
    if (!alive || !document.getElementById("ring-fg")) return;

    const frac   = Math.min(1, magnitude / currentThreshold);
    const offset = CIRC * (1 - frac);
    const color  = frac > 0.75 ? "var(--danger)" :
                   currentThreshold === THRESHOLD_FAST ? "var(--fast)" : "var(--alive)";

    const fg = document.getElementById("ring-fg");
    if (fg) {
      fg.style.strokeDashoffset = offset;
      fg.style.stroke           = color;
    }

    animFrame = requestAnimationFrame(animate);
  }
  animFrame = requestAnimationFrame(animate);
}

function updatePlayingTempo(fast) {
  const pill = document.getElementById("tempo-pill");
  const icon = document.getElementById("ring-icon");
  if (pill) {
    pill.className   = `p-tempo-pill ${fast ? "fast" : "slow"}`;
    pill.textContent = fast ? "⚡ DASH NOW ⚡" : "🎵 Stay Still";
  }
  if (icon) icon.textContent = fast ? "⚡" : "🛡️";

  // Pulse the background briefly on tempo change
  const wrap = document.getElementById("playing-wrap");
  if (wrap && fast) {
    wrap.style.background = "rgba(255,170,0,0.04)";
    setTimeout(() => { if (wrap) wrap.style.background = ""; }, 400);
  }
}

/* ============================================================
   MOTION DETECTION
   ============================================================ */
let motionHandler = null;

function startMotion() {
  if (motionHandler) return;

  motionHandler = e => {
    const raw = e.accelerationIncludingGravity;
    if (!raw || raw.x === null) return;

    // High-pass filter: subtract low-frequency gravity component
    gx = GRAVITY_ALPHA * gx + (1 - GRAVITY_ALPHA) * raw.x;
    gy = GRAVITY_ALPHA * gy + (1 - GRAVITY_ALPHA) * raw.y;
    gz = GRAVITY_ALPHA * gz + (1 - GRAVITY_ALPHA) * raw.z;

    const mx = raw.x - gx;
    const my = raw.y - gy;
    const mz = raw.z - gz;
    magnitude = Math.sqrt(mx * mx + my * my + mz * mz);

    if (magnitude > currentThreshold && Date.now() > graceUntil && alive) {
      handleElimination();
    }
  };

  window.addEventListener("devicemotion", motionHandler);
}

function stopMotion() {
  if (motionHandler) {
    window.removeEventListener("devicemotion", motionHandler);
    motionHandler = null;
  }
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

async function handleElimination() {
  if (!alive) return;
  alive = false;
  stopMotion();

  // Flash red
  const flash = document.createElement("div");
  flash.className = "flash";
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 500);

  // Vibrate
  if (navigator.vibrate) navigator.vibrate([80, 40, 200, 40, 80]);

  renderDead();

  // Write to Firebase
  if (roomRef) {
    await updateDoc(roomRef, { [`players.${pid}.alive`]: false });
  }
}

/* ============================================================
   DEAD SCREEN
   ============================================================ */
function renderDead() {
  stopMotion();
  app.innerHTML = `
    <div class="p-dead">
      <div class="big-em">💀</div>
      <h2>YOU'RE OUT</h2>
      <p>You moved too fast!</p>
      <p style="margin-top:16px">Watch the TV…</p>
    </div>
  `;
}

/* ============================================================
   WINNER SCREEN
   ============================================================ */
function renderWinner(data) {
  stopMotion();

  const isWinner = data.winnerId === pid;
  const winner   = data.players?.[data.winnerId];

  app.innerHTML = `
    <div class="p-winner ${isWinner ? "won" : ""}">
      <div class="big-em">${isWinner ? "🏆" : "👏"}</div>
      <h2>${isWinner ? "YOU WIN!" : (winner ? `${winner.name} wins!` : "Game over!")}</h2>
      <p>${isWinner
        ? "You were the last one standing!"
        : "Better luck next time!"
      }</p>
    </div>
  `;
}
