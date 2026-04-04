import { db } from "./firebase-init.js";
import {
  doc, getDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   SETUP
   ============================================================ */
const screen   = document.getElementById("phone-app");
const playerId = sessionStorage.getItem("whodunnit_pid") || crypto.randomUUID();
sessionStorage.setItem("whodunnit_pid", playerId);

let playerName = "";
let unsubscribe = null;

// Pre-fill room code from URL param (?room=XXXX)
const urlRoom = new URLSearchParams(window.location.search).get("room") || "";

renderJoin();

/* ============================================================
   JOIN SCREEN
   ============================================================ */
function renderJoin(errorMsg = "") {
  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>

    <div class="join-screen">
      <h2>Join the game 👋</h2>
      <p class="subtitle">Enter the room code shown on the TV</p>

      ${errorMsg ? `<div class="error-msg">${errorMsg}</div>` : ""}

      <input
        class="input-field"
        id="code-input"
        placeholder="Room Code"
        maxlength="4"
        value="${urlRoom}"
        autocomplete="off"
        spellcheck="false"
      />

      <input
        class="input-field name-field"
        id="name-input"
        placeholder="Your name"
        maxlength="20"
        autocomplete="off"
      />

      <button class="btn btn-primary" id="join-btn" style="width:100%;margin-top:8px">
        Let's Go →
      </button>
    </div>
  `;

  // Auto-focus name if room code pre-filled
  if (urlRoom) {
    document.getElementById("name-input").focus();
  } else {
    document.getElementById("code-input").focus();
  }

  document.getElementById("join-btn").onclick = attemptJoin;

  // Allow Enter key to submit
  screen.addEventListener("keydown", e => {
    if (e.key === "Enter") attemptJoin();
  }, { once: true });
}

async function attemptJoin() {
  const code = document.getElementById("code-input").value.trim().toUpperCase();
  const name = document.getElementById("name-input").value.trim();

  if (!code || code.length !== 4) {
    renderJoin("Please enter a 4-letter room code.");
    return;
  }
  if (!name) {
    renderJoin("Please enter your name.");
    return;
  }

  // Show loading
  document.getElementById("join-btn").textContent = "Joining…";
  document.getElementById("join-btn").disabled = true;

  const roomRef = doc(db, "rooms", code);

  try {
    const snap = await getDoc(roomRef);

    if (!snap.exists()) {
      renderJoin(`Room "${code}" not found. Check the TV!`);
      return;
    }

    if (snap.data().state !== "LOBBY") {
      renderJoin("That game has already started. Wait for the next round!");
      return;
    }

    playerName = name;

    await updateDoc(roomRef, {
      [`players.${playerId}`]: { name, score: 0 }
    });

    listen(roomRef);

  } catch (err) {
    console.error(err);
    renderJoin("Something went wrong. Try again.");
  }
}

/* ============================================================
   ROOM LISTENER
   ============================================================ */
function listen(roomRef) {
  if (unsubscribe) unsubscribe();

  unsubscribe = onSnapshot(roomRef, snap => {
    const data = snap.data();
    if (!data) return;

    const inRound = data.roundPlayerIds?.includes(playerId);

    switch (data.state) {

      case "LOBBY":
        renderWait("You're in!", "Waiting for the host to start…", "🎉");
        break;

      case "PROMPT":
        renderWait("Round starting!", "Look at the TV…", "📺");
        break;

      case "GUESSING":
        if (!inRound) { renderSidelined(); break; }
        if (data.guesses?.[playerId] !== undefined) {
          renderLocked("Guess locked in!", "Watch the TV while others guess.");
        } else {
          renderGuess(roomRef, data);
        }
        break;

      case "VOTING":
        if (!inRound) { renderSidelined(); break; }
        if (data.votes?.[playerId] !== undefined) {
          renderLocked("Vote submitted!", "Watch the TV for the reveal.");
        } else {
          renderVote(roomRef, data);
        }
        break;

      case "REVEAL":
      case "SCOREBOARD":
        renderWait("👀 Watch the TV!", "Scores are being tallied…", "🏆");
        break;
    }
  });
}

/* ============================================================
   WAIT / LOCKED / SIDELINED SCREENS
   ============================================================ */
function renderWait(title, subtitle, emoji) {
  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>
    <div class="wait-screen">
      <div class="big-emoji">${emoji}</div>
      <h2>${title}</h2>
      <p>${subtitle}</p>
      ${playerName ? `<div class="name-tag">Playing as ${playerName}</div>` : ""}
      <div class="dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
}

function renderLocked(title, subtitle) {
  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>
    <div class="locked-screen">
      <div class="lock-icon">🔒</div>
      <h3>${title}</h3>
      <p>${subtitle}</p>
      ${playerName ? `<div class="name-tag" style="margin-top:16px">Playing as ${playerName}</div>` : ""}
    </div>
  `;
}

function renderSidelined() {
  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>
    <div class="wait-screen">
      <div class="big-emoji">😴</div>
      <h2>Sit this one out</h2>
      <p>You joined after the round started. You'll play next round!</p>
    </div>
  `;
}

/* ============================================================
   GUESS SCREEN
   ============================================================ */
function renderGuess(roomRef, data) {
  const maxPlayers = data.roundPlayerIds.length;
  let currentGuess = 0;

  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>
    <div class="guess-screen">
      <div class="phone-prompt">${data.prompt}</div>
      <div class="guess-label">How many people in the room have done this?</div>

      <div class="guess-picker-wrap">
        <div class="guess-picker">
          <button class="pick-btn" id="dec-btn">−</button>
          <div class="pick-num" id="guess-num">0</div>
          <button class="pick-btn" id="inc-btn">+</button>
        </div>
        <div class="max-hint">out of ${maxPlayers} players</div>
      </div>

      <button class="btn btn-primary" id="submit-btn" style="width:100%">
        Lock In My Guess 🔒
      </button>
    </div>
  `;

  const numEl = document.getElementById("guess-num");

  document.getElementById("dec-btn").onclick = () => {
    if (currentGuess > 0) { currentGuess--; numEl.textContent = currentGuess; }
  };
  document.getElementById("inc-btn").onclick = () => {
    if (currentGuess < maxPlayers) { currentGuess++; numEl.textContent = currentGuess; }
  };

  document.getElementById("submit-btn").onclick = async () => {
    document.getElementById("submit-btn").textContent = "Locking in…";
    document.getElementById("submit-btn").disabled = true;
    await updateDoc(roomRef, {
      [`guesses.${playerId}`]: currentGuess
    });
  };
}

/* ============================================================
   VOTE SCREEN
   ============================================================ */
function renderVote(roomRef, data) {
  screen.innerHTML = `
    <div class="phone-logo">WHO<span>DUNNIT</span></div>
    <div class="vote-screen">
      <div class="phone-prompt">${data.prompt}</div>

      <div class="vote-question">Have YOU done this? 🤫</div>

      <div class="vote-buttons">
        <button class="btn btn-yes" id="yes-btn">YES 👋</button>
        <button class="btn btn-no"  id="no-btn">NO 🙈</button>
      </div>
    </div>
  `;

  document.getElementById("yes-btn").onclick = () => submitVote(roomRef, true);
  document.getElementById("no-btn").onclick  = () => submitVote(roomRef, false);
}

async function submitVote(roomRef, value) {
  // Immediate visual feedback
  document.getElementById("yes-btn")?.setAttribute("disabled", true);
  document.getElementById("no-btn")?.setAttribute("disabled", true);

  await updateDoc(roomRef, {
    [`votes.${playerId}`]: value
  });
}
