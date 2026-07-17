/**
 * MLB Live Board — fully client-side.
 * Fetches the free MLB Stats API from the browser (works on any network / phone).
 */
const MLB_API = "https://statsapi.mlb.com/api/v1";
const REFRESH_MS = 20_000;
const PT = "America/Los_Angeles";

const boardEl = document.getElementById("board");
const summaryEl = document.getElementById("summary");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const statusText = document.getElementById("statusText");
const liveDot = document.getElementById("liveDot");
const dateInput = document.getElementById("dateInput");
const refreshBtn = document.getElementById("refreshBtn");

let filter = "all";
let lastPayload = null;
let timer = null;

function todayLocalISO() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: PT,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

dateInput.value = todayLocalISO();

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    filter = chip.dataset.filter;
    if (lastPayload) render(lastPayload);
  });
});

refreshBtn.addEventListener("click", () => loadGames(true));
dateInput.addEventListener("change", () => loadGames(true));

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function badgeClass(status) {
  if (status === "Live") return "live";
  if (status === "Final") return "final";
  return "preview";
}

function formatRecord(side) {
  if (side.wins == null || side.losses == null) return "";
  return `<span class="record">${side.wins}-${side.losses}</span>`;
}

function pitcherBlock(side, sideLabel) {
  const sp = side.starter;
  if (!sp) {
    return `
      <div class="pitcher-row">
        <div class="pitcher-info">
          <div class="pitcher-label">${sideLabel} SP</div>
          <div class="pitcher-name">TBD</div>
        </div>
        <div class="k-block">
          <div class="k-num">—</div>
          <div class="k-label">Ks</div>
        </div>
      </div>`;
  }

  const lineParts = [];
  if (!sp.pregame) {
    if (sp.inningsPitched && sp.inningsPitched !== "0.0") lineParts.push(`${sp.inningsPitched} IP`);
    if (sp.pitches) lineParts.push(`${sp.pitches} P`);
    if (sp.walks != null) lineParts.push(`${sp.walks} BB`);
  } else {
    lineParts.push("Probable");
  }

  const line = lineParts.length
    ? `<div class="pitcher-line">${esc(lineParts.join(" · "))}</div>`
    : "";

  return `
    <div class="pitcher-row">
      <div class="pitcher-info">
        <div class="pitcher-label">${sideLabel} SP</div>
        <div class="pitcher-name" title="${esc(sp.name)}">${esc(sp.name || "TBD")}</div>
        ${line}
      </div>
      <div class="k-block">
        <div class="k-num">${sp.pregame ? "0" : esc(sp.strikeouts ?? 0)}</div>
        <div class="k-label">Ks</div>
      </div>
    </div>`;
}

function gameCard(g) {
  const status = g.status || "Preview";
  const awayWinner = g.away?.isWinner ? "winner" : "";
  const homeWinner = g.home?.isWinner ? "winner" : "";
  const scoreDim = status === "Preview" ? "dim" : "";

  let countHtml = "";
  if (status === "Live" && g.balls != null) {
    countHtml = `<div class="count"><span>B ${g.balls}</span><span>S ${g.strikes}</span><span>O ${g.outs}</span></div>`;
  }

  const timeOrVenue = [g.gameTime, g.venue].filter(Boolean).join(" · ");

  return `
    <article class="card ${status === "Live" ? "live" : ""}" data-status="${esc(status)}">
      <div class="card-head">
        <span class="badge ${badgeClass(status)}">${esc(g.inningLabel || g.detailedState || status)}</span>
        <div class="meta">${esc(timeOrVenue)}</div>
      </div>
      <div class="teams">
        <div class="row">
          <div class="team-name ${awayWinner}">
            ${esc(g.away?.name || "Away")}${formatRecord(g.away || {})}
          </div>
          <div class="score ${scoreDim}">${esc(g.away?.score ?? 0)}</div>
        </div>
        <div class="row">
          <div class="team-name ${homeWinner}">
            ${esc(g.home?.name || "Home")}${formatRecord(g.home || {})}
          </div>
          <div class="score ${scoreDim}">${esc(g.home?.score ?? 0)}</div>
        </div>
      </div>
      ${countHtml}
      <div class="pitchers">
        ${pitcherBlock(g.away || {}, "Away")}
        ${pitcherBlock(g.home || {}, "Home")}
      </div>
    </article>`;
}

function render(payload) {
  lastPayload = payload;
  const games = payload.games || [];
  const filtered =
    filter === "all" ? games : games.filter((g) => g.status === filter);

  const live = games.filter((g) => g.status === "Live").length;
  const final = games.filter((g) => g.status === "Final").length;
  const preview = games.filter((g) => g.status === "Preview").length;

  summaryEl.textContent = `${payload.date} · ${games.length} games · ${live} live · ${preview} upcoming · ${final} final`;

  if (!filtered.length) {
    boardEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    boardEl.innerHTML = filtered.map(gameCard).join("");
  }

  const hasLive = live > 0;
  liveDot.className = "dot " + (hasLive ? "live-pulse" : "ok");
  const updated = payload.updatedAt
    ? new Date(payload.updatedAt).toLocaleTimeString()
    : "";
  statusText.textContent = hasLive
    ? `Live · updated ${updated}`
    : `Updated ${updated}`;
}

/* ── MLB data layer (browser → statsapi.mlb.com) ── */

async function mlbGet(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const url = `${MLB_API}/${path.replace(/^\//, "")}?${qs}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`MLB API ${res.status}`);
  return res.json();
}

function asInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function pitcherLine(teamBox, pitcherId) {
  if (!pitcherId) return null;
  const player = teamBox?.players?.[`ID${pitcherId}`] || {};
  const person = player.person || {};
  const pitching = player.stats?.pitching || {};
  return {
    id: pitcherId,
    name: person.fullName || "TBD",
    strikeouts: asInt(pitching.strikeOuts),
    inningsPitched: pitching.inningsPitched || "0.0",
    pitches: asInt(pitching.numberOfPitches) || asInt(pitching.pitchesThrown),
    walks: asInt(pitching.baseOnBalls),
    hits: asInt(pitching.hits),
    earnedRuns: asInt(pitching.earnedRuns),
    note: pitching.note || "",
    summary: pitching.summary || "",
    pregame: false,
  };
}

function extractStarter(teamBox, probableId) {
  const pitchers = teamBox?.pitchers || [];
  if (!pitchers.length) {
    if (!probableId) return null;
    return {
      id: probableId,
      name: null,
      strikeouts: 0,
      inningsPitched: "0.0",
      pitches: 0,
      walks: 0,
      hits: 0,
      earnedRuns: 0,
      note: "",
      summary: "",
      pregame: true,
    };
  }
  let starterId = pitchers[0];
  if (probableId && pitchers.includes(probableId)) starterId = probableId;
  return pitcherLine(teamBox, starterId);
}

function buildSide(teamBlock, sideBox, scoreFallback) {
  const team = teamBlock?.team || {};
  const probable = teamBlock?.probablePitcher || {};
  const probableId = probable.id;
  const probableName = probable.fullName;

  let starter = null;
  if (sideBox) {
    starter = extractStarter(sideBox, probableId);
    if (starter && !starter.name) starter.name = probableName || "TBD";
  } else if (probableId || probableName) {
    starter = {
      id: probableId,
      name: probableName || "TBD",
      strikeouts: 0,
      inningsPitched: "0.0",
      pitches: 0,
      walks: 0,
      hits: 0,
      earnedRuns: 0,
      note: "",
      summary: "",
      pregame: true,
    };
  }

  let score = teamBlock?.score;
  if (score == null) score = scoreFallback;
  const record = teamBlock?.leagueRecord || {};

  let abbreviation = team.abbreviation || team.teamName || "";
  if (!abbreviation && team.name) {
    const parts = team.name.split(" ");
    abbreviation = (parts[parts.length - 1] || "???").slice(0, 3).toUpperCase();
  }

  return {
    id: team.id,
    name: team.name || "TBD",
    abbreviation,
    score: score != null ? score : 0,
    wins: record.wins,
    losses: record.losses,
    isWinner: Boolean(teamBlock?.isWinner),
    starter,
  };
}

function formatGameTimePT(iso) {
  if (!iso) return { gameTime: "", startTs: 0 };
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return { gameTime: "", startTs: 0 };
  const gameTime = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(dt)
    .replace(/\s(AM|PM)/, " $1 PT");
  // Ensure "PT" suffix even if locale differs slightly
  const withPt = gameTime.includes("PT") ? gameTime : `${gameTime} PT`;
  return { gameTime: withPt, startTs: dt.getTime() / 1000 };
}

async function enrichGame(game) {
  const status = game.status || {};
  const abstract = status.abstractGameState || "Preview";
  const detailed = status.detailedState || abstract;
  const linescore = game.linescore || {};
  const teams = game.teams || {};
  const awayBlock = teams.away || {};
  const homeBlock = teams.home || {};
  const gamePk = game.gamePk;

  const needBox =
    abstract === "Live" ||
    abstract === "Final" ||
    !["Scheduled", "Pre-Game", "Warmup"].includes(detailed);

  let box = null;
  if (needBox && gamePk) {
    try {
      box = await mlbGet(`game/${gamePk}/boxscore`);
    } catch {
      box = null;
    }
  }

  const awayBox = box?.teams?.away || null;
  const homeBox = box?.teams?.home || null;
  const lsTeams = linescore.teams || {};
  const awayRuns = lsTeams.away?.runs;
  const homeRuns = lsTeams.home?.runs;

  let inningLabel = detailed;
  if (abstract === "Live") {
    const state = linescore.inningState || "";
    const ordinal = linescore.currentInningOrdinal || "";
    inningLabel = `${state} ${ordinal}`.trim() || detailed;
  } else if (abstract === "Final") {
    const innings = linescore.currentInning || 9;
    inningLabel = innings <= 9 ? "Final" : `Final/${innings}`;
  }

  const { gameTime, startTs } = formatGameTimePT(game.gameDate);

  return {
    gamePk,
    status: abstract,
    detailedState: detailed,
    inningLabel,
    balls: linescore.balls ?? null,
    strikes: linescore.strikes ?? null,
    outs: linescore.outs ?? null,
    venue: game.venue?.name || "",
    gameTime,
    gameDate: game.officialDate || "",
    startTs,
    away: buildSide(awayBlock, awayBox, awayRuns),
    home: buildSide(homeBlock, homeBox, homeRuns),
  };
}

async function fetchGames(dateStr) {
  const schedule = await mlbGet("schedule", {
    sportId: 1,
    date: dateStr,
    hydrate: "linescore,probablePitcher,team",
  });

  const raw = [];
  for (const day of schedule.dates || []) {
    raw.push(...(day.games || []));
  }

  const games = await Promise.all(raw.map((g) => enrichGame(g)));
  games.sort((a, b) => (a.startTs || 0) - (b.startTs || 0) || (a.gamePk || 0) - (b.gamePk || 0));

  return {
    date: dateStr,
    updatedAt: new Date().toISOString(),
    gameCount: games.length,
    games,
  };
}

async function loadGames(manual = false) {
  if (manual) statusText.textContent = "Refreshing…";

  const date = dateInput.value || todayLocalISO();

  try {
    const data = await fetchGames(date);
    errorEl.classList.add("hidden");
    render(data);
  } catch (err) {
    liveDot.className = "dot err";
    statusText.textContent = "Error";
    errorEl.textContent = `Could not load games: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => loadGames(false), REFRESH_MS);
}

loadGames(true);
startPolling();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadGames(false);
});
