/**
 * Live Board — multi-sport scores + MLB K prop tracker
 * Client-side only (GitHub Pages friendly).
 */

const MLB_API = "https://statsapi.mlb.com/api/v1";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const OPENDOTA = "https://api.opendota.com/api";
const REFRESH_MS = 20_000;
const PT = "America/Los_Angeles";
const TRACK_KEY = "liveboard.tracks";

/* ── DOM ── */
const boardEl = document.getElementById("board");
const summaryEl = document.getElementById("summary");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const statusText = document.getElementById("statusText");
const liveDot = document.getElementById("liveDot");
const dateInput = document.getElementById("dateInput");
const dateWrap = document.getElementById("dateWrap");
const refreshBtn = document.getElementById("refreshBtn");
const filtersEl = document.getElementById("filters");
const scoreView = document.getElementById("scoreView");
const trackView = document.getElementById("trackView");
const trackForm = document.getElementById("trackForm");
const trackPlayer = document.getElementById("trackPlayer");
const trackSide = document.getElementById("trackSide");
const trackLine = document.getElementById("trackLine");
const trackNote = document.getElementById("trackNote");
const trackBoard = document.getElementById("trackBoard");
const trackEmpty = document.getElementById("trackEmpty");
const trackCount = document.getElementById("trackCount");
const clearSettledBtn = document.getElementById("clearSettledBtn");

/* ── State ── */
let activeTab = "mlb";
let filter = "all";
let timer = null;
let mlbCache = null; // last MLB payload for Track
let loadGen = 0; // cancels stale async renders when switching tabs
const cache = { mlb: null, nba: null, tennis: null, esports: null };

/* ── Utils ── */
function todayPT() {
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

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatTimePT(iso) {
  if (!iso) return { gameTime: "", startTs: 0 };
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return { gameTime: "", startTs: 0 };
  const gameTime =
    new Intl.DateTimeFormat("en-US", {
      timeZone: PT,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dt) + " PT";
  return { gameTime, startTs: dt.getTime() / 1000 };
}

function badgeClass(status) {
  if (status === "Live") return "live";
  if (status === "Final") return "final";
  return "preview";
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── Track storage ── */
function loadTracks() {
  try {
    const raw = localStorage.getItem(TRACK_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveTracks(list) {
  localStorage.setItem(TRACK_KEY, JSON.stringify(list));
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── MLB ── */
async function mlbGet(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  return getJson(`${MLB_API}/${path.replace(/^\//, "")}?${qs}`);
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
      pregame: true,
    };
  }
  let starterId = pitchers[0];
  if (probableId && pitchers.includes(probableId)) starterId = probableId;
  return pitcherLine(teamBox, starterId);
}

function buildMlbSide(teamBlock, sideBox, scoreFallback) {
  const team = teamBlock?.team || {};
  const probable = teamBlock?.probablePitcher || {};
  let starter = null;
  if (sideBox) {
    starter = extractStarter(sideBox, probable.id);
    if (starter && !starter.name) starter.name = probable.fullName || "TBD";
  } else if (probable.id || probable.fullName) {
    starter = {
      id: probable.id,
      name: probable.fullName || "TBD",
      strikeouts: 0,
      inningsPitched: "0.0",
      pitches: 0,
      walks: 0,
      pregame: true,
    };
  }
  let score = teamBlock?.score;
  if (score == null) score = scoreFallback;
  const record = teamBlock?.leagueRecord || {};
  return {
    id: team.id,
    name: team.name || "TBD",
    abbreviation: team.abbreviation || "",
    score: score != null ? score : 0,
    wins: record.wins,
    losses: record.losses,
    isWinner: Boolean(teamBlock?.isWinner),
    starter,
  };
}

async function enrichMlbGame(game) {
  const status = game.status || {};
  const abstract = status.abstractGameState || "Preview";
  const detailed = status.detailedState || abstract;
  const linescore = game.linescore || {};
  const teams = game.teams || {};
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

  let inningLabel = detailed;
  if (abstract === "Live") {
    inningLabel = `${linescore.inningState || ""} ${linescore.currentInningOrdinal || ""}`.trim() || detailed;
  } else if (abstract === "Final") {
    const innings = linescore.currentInning || 9;
    inningLabel = innings <= 9 ? "Final" : `Final/${innings}`;
  }

  const { gameTime, startTs } = formatTimePT(game.gameDate);
  const away = buildMlbSide(teams.away, awayBox, lsTeams.away?.runs);
  const home = buildMlbSide(teams.home, homeBox, lsTeams.home?.runs);

  return {
    sport: "mlb",
    gamePk,
    status: abstract,
    detailedState: detailed,
    inningLabel,
    balls: linescore.balls ?? null,
    strikes: linescore.strikes ?? null,
    outs: linescore.outs ?? null,
    venue: game.venue?.name || "",
    gameTime,
    startTs,
    away,
    home,
  };
}

async function fetchMlb(dateStr) {
  const schedule = await mlbGet("schedule", {
    sportId: 1,
    date: dateStr,
    hydrate: "linescore,probablePitcher,team",
  });
  const raw = [];
  for (const day of schedule.dates || []) raw.push(...(day.games || []));
  const games = await Promise.all(raw.map(enrichMlbGame));
  games.sort((a, b) => (a.startTs || 0) - (b.startTs || 0) || (a.gamePk || 0) - (b.gamePk || 0));
  return {
    date: dateStr,
    updatedAt: new Date().toISOString(),
    games,
  };
}

/* ── ESPN helpers (NBA / Tennis) ── */
function mapEspnStatus(type) {
  const state = (type?.state || "").toLowerCase();
  const name = (type?.name || "").toUpperCase();
  if (state === "in" || name.includes("IN_PROGRESS") || name.includes("HALFTIME")) return "Live";
  if (state === "post" || name.includes("FINAL") || name.includes("STATUS_FINAL")) return "Final";
  return "Preview";
}

async function fetchNba(dateStr) {
  // ESPN date as yyyymmdd
  const ymd = (dateStr || todayPT()).replace(/-/g, "");
  const data = await getJson(`${ESPN}/basketball/nba/scoreboard?dates=${ymd}`);
  const games = (data.events || []).map((ev) => {
    const comp = (ev.competitions || [])[0] || {};
    const comps = comp.competitors || [];
    const home = comps.find((c) => c.homeAway === "home") || comps[1] || {};
    const away = comps.find((c) => c.homeAway === "away") || comps[0] || {};
    const status = mapEspnStatus(ev.status?.type);
    const { gameTime, startTs } = formatTimePT(ev.date);
    let inningLabel = ev.status?.type?.shortDetail || ev.status?.type?.description || status;
    if (status === "Live") {
      const clock = ev.status?.displayClock || "";
      const period = ev.status?.period;
      inningLabel = clock ? `Q${period || "?"} ${clock}` : inningLabel;
    }
    return {
      sport: "nba",
      gamePk: ev.id,
      status,
      inningLabel,
      gameTime,
      startTs,
      venue: comp.venue?.fullName || "",
      away: {
        name: away.team?.displayName || "Away",
        score: asInt(away.score),
        isWinner: Boolean(away.winner),
        wins: away.records?.[0]?.summary?.split("-")[0],
        losses: away.records?.[0]?.summary?.split("-")[1],
      },
      home: {
        name: home.team?.displayName || "Home",
        score: asInt(home.score),
        isWinner: Boolean(home.winner),
        wins: home.records?.[0]?.summary?.split("-")[0],
        losses: home.records?.[0]?.summary?.split("-")[1],
      },
    };
  });
  games.sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  return { date: dateStr, updatedAt: new Date().toISOString(), games };
}

async function fetchTennis() {
  const [atp, wta] = await Promise.all([
    getJson(`${ESPN}/tennis/atp/scoreboard`).catch(() => ({ events: [] })),
    getJson(`${ESPN}/tennis/wta/scoreboard`).catch(() => ({ events: [] })),
  ]);

  const parse = (data, tour) =>
    (data.events || []).map((ev) => {
      const status = mapEspnStatus(ev.status?.type);
      const { gameTime, startTs } = formatTimePT(ev.date);
      // competitions can nest matches
      const comps = ev.competitions || [];
      const first = comps[0] || {};
      const competitors = first.competitors || [];
      let awayName = competitors[0]?.athlete?.displayName || competitors[0]?.team?.displayName;
      let homeName = competitors[1]?.athlete?.displayName || competitors[1]?.team?.displayName;
      let awayScore = competitors[0]?.score ?? "";
      let homeScore = competitors[1]?.score ?? "";

      // group events sometimes only have name
      if (!awayName && !homeName) {
        const parts = (ev.name || ev.shortName || "Match").split(" at ");
        if (parts.length === 2) {
          awayName = parts[0];
          homeName = parts[1];
        } else {
          awayName = ev.name || "Match";
          homeName = tour;
        }
      }

      return {
        sport: "tennis",
        gamePk: `${tour}-${ev.id}`,
        status,
        inningLabel: ev.status?.type?.shortDetail || ev.status?.type?.description || status,
        gameTime,
        startTs,
        venue: ev.season?.name || first.notes?.[0]?.headline || tour.toUpperCase(),
        tour,
        away: { name: awayName || "Player 1", score: awayScore, isWinner: Boolean(competitors[0]?.winner) },
        home: { name: homeName || "Player 2", score: homeScore, isWinner: Boolean(competitors[1]?.winner) },
      };
    });

  const games = [...parse(atp, "ATP"), ...parse(wta, "WTA")];
  const order = { Live: 0, Preview: 1, Final: 2 };
  games.sort(
    (a, b) =>
      (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.startTs || 0) - (b.startTs || 0)
  );
  return { date: todayPT(), updatedAt: new Date().toISOString(), games };
}

/* ── Esports (Dota 2 pro via OpenDota) ── */
async function fetchEsports() {
  const matches = await getJson(`${OPENDOTA}/proMatches`);
  const games = (matches || []).slice(0, 24).map((m) => {
    const startTs = m.start_time || 0;
    const { gameTime } = formatTimePT(startTs ? new Date(startTs * 1000).toISOString() : null);
    const radiant = m.radiant_name || `Team ${m.radiant_team_id || "?"}`;
    const dire = m.dire_name || `Team ${m.dire_team_id || "?"}`;
    const finished = m.duration != null && m.duration > 0;
    return {
      sport: "esports",
      gamePk: m.match_id,
      status: finished ? "Final" : "Live",
      inningLabel: finished
        ? `Final · ${Math.floor((m.duration || 0) / 60)}m`
        : "Recent / Live",
      gameTime,
      startTs,
      venue: m.league_name || "Dota 2 Pro",
      away: {
        name: radiant.trim() || "Radiant",
        score: m.radiant_score ?? 0,
        isWinner: m.radiant_win === true,
      },
      home: {
        name: dire.trim() || "Dire",
        score: m.dire_score ?? 0,
        isWinner: m.radiant_win === false,
      },
      note: "Dota 2",
    };
  });
  return {
    date: todayPT(),
    updatedAt: new Date().toISOString(),
    games,
    banner: "Esports v1: Dota 2 pro matches (OpenDota). LoL / CS / Valorant can be added later.",
  };
}

/* ── Rendering scoreboards ── */
function formatRecord(side) {
  if (side.wins == null || side.losses == null || side.wins === "" || side.losses === "") return "";
  return `<span class="record">${esc(side.wins)}-${esc(side.losses)}</span>`;
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
        <div class="k-block"><div class="k-num">—</div><div class="k-label">Ks</div></div>
      </div>`;
  }
  const lineParts = [];
  if (!sp.pregame) {
    if (sp.inningsPitched && sp.inningsPitched !== "0.0") lineParts.push(`${sp.inningsPitched} IP`);
    if (sp.pitches) lineParts.push(`${sp.pitches} P`);
    if (sp.walks != null) lineParts.push(`${sp.walks} BB`);
  } else lineParts.push("Probable");
  const line = lineParts.length ? `<div class="pitcher-line">${esc(lineParts.join(" · "))}</div>` : "";
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
  const scoreDim = status === "Preview" && g.sport !== "esports" ? "dim" : "";
  let countHtml = "";
  if (g.sport === "mlb" && status === "Live" && g.balls != null) {
    countHtml = `<div class="count"><span>B ${g.balls}</span><span>S ${g.strikes}</span><span>O ${g.outs}</span></div>`;
  }
  const timeOrVenue = [g.gameTime, g.venue, g.note].filter(Boolean).join(" · ");
  const pitchers =
    g.sport === "mlb"
      ? `<div class="pitchers">${pitcherBlock(g.away || {}, "Away")}${pitcherBlock(g.home || {}, "Home")}</div>`
      : "";

  return `
    <article class="card ${status === "Live" ? "live" : ""}" data-status="${esc(status)}">
      <div class="card-head">
        <span class="badge ${badgeClass(status)}">${esc(g.inningLabel || status)}</span>
        <div class="meta">${esc(timeOrVenue)}</div>
      </div>
      <div class="teams">
        <div class="row">
          <div class="team-name ${g.away?.isWinner ? "winner" : ""}">
            ${esc(g.away?.name || "Away")}${formatRecord(g.away || {})}
          </div>
          <div class="score ${scoreDim}">${esc(g.away?.score ?? 0)}</div>
        </div>
        <div class="row">
          <div class="team-name ${g.home?.isWinner ? "winner" : ""}">
            ${esc(g.home?.name || "Home")}${formatRecord(g.home || {})}
          </div>
          <div class="score ${scoreDim}">${esc(g.home?.score ?? 0)}</div>
        </div>
      </div>
      ${countHtml}
      ${pitchers}
    </article>`;
}

function renderScoreboard(payload) {
  const games = payload.games || [];
  const filtered = filter === "all" ? games : games.filter((g) => g.status === filter);
  const live = games.filter((g) => g.status === "Live").length;
  const final = games.filter((g) => g.status === "Final").length;
  const preview = games.filter((g) => g.status === "Preview").length;

  let summary = `${payload.date || ""} · ${games.length} games · ${live} live · ${preview} upcoming · ${final} final`;
  if (payload.banner) summary = payload.banner + " · " + summary;
  summaryEl.textContent = summary.replace(/^ · /, "");

  if (!filtered.length) {
    boardEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    boardEl.innerHTML = filtered.map(gameCard).join("");
  }

  const hasLive = live > 0;
  liveDot.className = "dot " + (hasLive ? "live-pulse" : "ok");
  const updated = payload.updatedAt ? new Date(payload.updatedAt).toLocaleTimeString() : "";
  statusText.textContent = hasLive ? `Live · updated ${updated}` : `Updated ${updated}`;
}

/* ── Track: starters list + resolve ── */
function collectStarters(mlbPayload) {
  const list = [];
  const seen = new Set();
  for (const g of mlbPayload?.games || []) {
    for (const side of ["away", "home"]) {
      const team = g[side];
      const sp = team?.starter;
      if (!sp?.id && !sp?.name) continue;
      const key = String(sp.id || sp.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const opp = side === "away" ? g.home : g.away;
      list.push({
        id: sp.id,
        name: sp.name || "TBD",
        team: team.name,
        opponent: opp?.name || "",
        gamePk: g.gamePk,
        gameStatus: g.status,
        gameLabel: `${team.name} @ ${opp?.name || "?"}`,
        gameTime: g.gameTime,
      });
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/** Map option value → starter meta (avoids fragile JSON-in-HTML attributes) */
let starterMap = new Map();

function fillStarterSelect(mlbPayload) {
  const starters = collectStarters(mlbPayload);
  const prev = trackPlayer.value;
  starterMap = new Map();
  if (!starters.length) {
    trackPlayer.innerHTML = `<option value="">No starters found for this date</option>`;
    return;
  }
  const opts = [`<option value="">Select pitcher…</option>`];
  for (const s of starters) {
    const key = String(s.id || s.name);
    starterMap.set(key, {
      id: s.id,
      name: s.name,
      team: s.team,
      gamePk: s.gamePk,
      gameLabel: s.gameLabel,
    });
    opts.push(
      `<option value="${esc(key)}">${esc(s.name)} — ${esc(s.team)} (${esc(s.gameTime || "TBD")})</option>`
    );
  }
  trackPlayer.innerHTML = opts.join("");
  if (prev && starterMap.has(prev)) trackPlayer.value = prev;
}

/** Find live Ks for a tracked pitcher from MLB cache */
function resolvePitcherStats(track, mlbPayload) {
  for (const g of mlbPayload?.games || []) {
    for (const side of ["away", "home"]) {
      const sp = g[side]?.starter;
      if (!sp) continue;
      const idMatch = track.pitcherId && sp.id && String(sp.id) === String(track.pitcherId);
      const nameMatch =
        track.pitcherName &&
        sp.name &&
        sp.name.toLowerCase() === track.pitcherName.toLowerCase();
      if (idMatch || nameMatch) {
        return {
          strikeouts: sp.pregame ? 0 : sp.strikeouts ?? 0,
          pregame: Boolean(sp.pregame),
          gameStatus: g.status,
          inningLabel: g.inningLabel,
          gameLabel: `${g.away.name} @ ${g.home.name}`,
          team: g[side].name,
          ip: sp.inningsPitched,
          pitches: sp.pitches,
        };
      }
    }
    // Also scan if starter changed but track has gamePk — still try box via starter only
    if (track.gamePk && g.gamePk === track.gamePk) {
      // no starter match; leave for fallback
    }
  }
  return null;
}

/**
 * Prop result:
 *  - over: win if current > line, push if equal, lose if <
 *  - under: win if current < line, push if equal, lose if >
 */
function evaluateProp(side, line, current, gameStatus) {
  const c = Number(current);
  const L = Number(line);
  const settled = gameStatus === "Final";
  let covering;
  if (side === "under") covering = c < L;
  else covering = c > L;
  const push = c === L;

  let result = "pending";
  if (settled) {
    if (push) result = "push";
    else result = covering ? "hit" : "miss";
  } else if (gameStatus === "Live") {
    // Always LIVE while the game is in progress (not PENDING / COVERING)
    result = "live";
  } else {
    result = "pending";
  }
  return { covering, push, result, settled };
}

function trackCard(track, stats) {
  const current = stats?.strikeouts ?? 0;
  const line = Number(track.line);
  const side = track.side || "over";
  const gameStatus = stats?.gameStatus || "Preview";
  const { result, covering } = evaluateProp(side, line, current, gameStatus);

  const resultLabels = {
    hit: "HIT",
    miss: "MISS",
    push: "PUSH",
    live: "LIVE",
    pending: "PENDING",
  };
  const resultClass = {
    hit: "hit",
    miss: "miss",
    push: "push",
    live: "live-badge",
    pending: "pending",
  }[result];

  // Progress: for over, fill toward line; for under, show current vs line
  const pct = line > 0 ? Math.min(140, Math.round((current / line) * 100)) : 0;
  const barMod =
    result === "hit" || (result === "live" && covering)
      ? "bar-good"
      : result === "miss"
        ? "bar-bad"
        : result === "live"
          ? "bar-neutral"
          : "bar-neutral";

  const meta = [
    stats?.gameLabel || track.gameLabel,
    stats?.inningLabel || gameStatus,
    track.note,
  ]
    .filter(Boolean)
    .join(" · ");

  const lineTxt = `${side === "over" ? "Over" : "Under"} ${line} Ks`;
  const settledClass = result === "hit" || result === "miss" || result === "push" ? "settled" : "";

  return `
    <article class="track-card ${resultClass} ${settledClass}" data-id="${esc(track.id)}">
      <div class="track-card-head">
        <div>
          <div class="track-player">${esc(track.pitcherName)}</div>
          <div class="track-meta">${esc(meta)}</div>
        </div>
        <span class="result-badge ${resultClass}">${resultLabels[result]}</span>
      </div>
      <div class="track-stats">
        <div class="track-current">
          <span class="big-k">${esc(current)}</span>
          <span class="big-k-label">Ks now</span>
        </div>
        <div class="track-line-info">
          <div class="line-main">${esc(lineTxt)}</div>
          <div class="line-sub">${stats?.ip && stats.ip !== "0.0" ? esc(`${stats.ip} IP`) : ""}${stats?.pitches ? esc(` · ${stats.pitches} P`) : ""}</div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar ${barMod}" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <div class="progress-labels">
        <span>0</span>
        <span>line ${esc(line)} · ${esc(pct)}%</span>
      </div>
      <button type="button" class="btn-remove" data-remove="${esc(track.id)}">Remove</button>
    </article>`;
}

function renderTrack() {
  const tracks = loadTracks();
  const mlb = mlbCache || cache.mlb;
  trackCount.textContent = tracks.length
    ? `${tracks.length} tracked prop${tracks.length === 1 ? "" : "s"}`
    : "";

  if (!tracks.length) {
    trackBoard.innerHTML = "";
    trackEmpty.classList.remove("hidden");
  } else {
    trackEmpty.classList.add("hidden");
    trackBoard.innerHTML = tracks
      .map((t) => trackCard(t, resolvePitcherStats(t, mlb)))
      .join("");
  }

  if (liveDot) liveDot.className = "dot ok";
  if (statusText) {
    statusText.textContent = mlb?.updatedAt
      ? `Track · MLB updated ${new Date(mlb.updatedAt).toLocaleTimeString()}`
      : "Track";
  }
}

/* ── Tab / load orchestration ── */
function updateChromeForTab(tab) {
  document.querySelectorAll(".sport-tab").forEach((b) => {
    const on = b.getAttribute("data-tab") === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });

  const isTrack = tab === "track";
  if (scoreView) scoreView.classList.toggle("hidden", isTrack);
  if (trackView) trackView.classList.toggle("hidden", !isTrack);

  // Date picker: MLB + NBA only
  if (dateWrap) {
    dateWrap.classList.toggle(
      "hidden",
      tab === "tennis" || tab === "esports" || tab === "track"
    );
  }
  // Status filters on scoreboard sports
  if (filtersEl) {
    filtersEl.classList.toggle("hidden", tab === "track" || tab === "esports");
  }
}

function setTab(tab) {
  if (!tab) return;
  if (tab === activeTab && cache[tab]) {
    // already here — still re-render cached view
    updateChromeForTab(tab);
    if (tab === "track") renderTrack();
    else if (cache[tab]) renderScoreboard(cache[tab]);
    return;
  }

  activeTab = tab;
  // Reset status filter when switching sports so boards aren't empty
  filter = "all";
  document.querySelectorAll(".chip").forEach((c) => {
    c.classList.toggle("active", c.getAttribute("data-filter") === "all");
  });

  updateChromeForTab(tab);

  // Instant paint from cache while fresh data loads
  if (tab === "track") {
    boardEl.innerHTML = "";
    renderTrack();
  } else if (cache[tab]) {
    emptyEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    renderScoreboard(cache[tab]);
  } else {
    boardEl.innerHTML = "";
    summaryEl.textContent = "Loading…";
    emptyEl.classList.add("hidden");
    errorEl.classList.add("hidden");
  }

  loadActive(true);
}

async function ensureMlb(date) {
  const d = date || (dateInput && dateInput.value) || todayPT();
  const payload = await fetchMlb(d);
  cache.mlb = payload;
  mlbCache = payload;
  fillStarterSelect(payload);
  return payload;
}

async function loadActive(manual = false) {
  const gen = ++loadGen;
  const tab = activeTab;

  if (manual && statusText) statusText.textContent = "Refreshing…";
  if (errorEl) errorEl.classList.add("hidden");

  try {
    if (tab === "track") {
      await ensureMlb((dateInput && dateInput.value) || todayPT());
      if (gen !== loadGen || activeTab !== "track") return;
      renderTrack();
      return;
    }

    const date = (dateInput && dateInput.value) || todayPT();
    let payload;

    if (tab === "mlb") {
      payload = await ensureMlb(date);
    } else if (tab === "nba") {
      payload = await fetchNba(date);
      cache.nba = payload;
      // Keep starters warm for Track (ignore race)
      ensureMlb(date).catch(() => {});
    } else if (tab === "tennis") {
      payload = await fetchTennis();
      cache.tennis = payload;
    } else if (tab === "esports") {
      payload = await fetchEsports();
      cache.esports = payload;
    } else {
      return;
    }

    // Ignore stale responses after the user switched tabs
    if (gen !== loadGen || activeTab !== tab) return;
    renderScoreboard(payload);
  } catch (err) {
    if (gen !== loadGen || activeTab !== tab) return;
    if (liveDot) liveDot.className = "dot err";
    if (statusText) statusText.textContent = "Error";
    if (tab !== "track" && errorEl) {
      errorEl.textContent = `Could not load: ${err.message || err}`;
      errorEl.classList.remove("hidden");
    }
  }
}

/* ── Events (delegation — reliable on mobile) ── */
if (dateInput) dateInput.value = todayPT();

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest(".sport-tab");
  if (tabBtn) {
    e.preventDefault();
    setTab(tabBtn.getAttribute("data-tab"));
    return;
  }

  const chip = e.target.closest(".chip");
  if (chip && filtersEl && filtersEl.contains(chip)) {
    e.preventDefault();
    filtersEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    filter = chip.getAttribute("data-filter") || "all";
    if (activeTab !== "track") {
      const payload = cache[activeTab];
      if (payload) renderScoreboard(payload);
      else loadActive(true);
    }
    return;
  }

  const removeBtn = e.target.closest("[data-remove]");
  if (removeBtn && trackBoard && trackBoard.contains(removeBtn)) {
    e.preventDefault();
    const id = removeBtn.getAttribute("data-remove");
    saveTracks(loadTracks().filter((t) => t.id !== id));
    renderTrack();
  }
});

if (refreshBtn) refreshBtn.addEventListener("click", () => loadActive(true));
if (dateInput) dateInput.addEventListener("change", () => loadActive(true));

if (trackForm) {
  trackForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = trackPlayer && trackPlayer.value;
    if (!key) return;
    const parsed = starterMap.get(key);
    if (!parsed) return;
    const line = parseFloat(trackLine.value);
    if (!Number.isFinite(line) || line < 0) return;

    const tracks = loadTracks();
    tracks.unshift({
      id: uid(),
      sport: "mlb",
      market: "strikeouts",
      pitcherId: parsed.id,
      pitcherName: parsed.name,
      team: parsed.team,
      gamePk: parsed.gamePk,
      gameLabel: parsed.gameLabel,
      side: trackSide.value,
      line,
      note: ((trackNote && trackNote.value) || "").trim(),
      createdAt: new Date().toISOString(),
    });
    saveTracks(tracks);
    if (trackNote) trackNote.value = "";
    if (activeTab !== "track") setTab("track");
    else renderTrack();
  });
}

if (clearSettledBtn) {
  clearSettledBtn.addEventListener("click", () => {
    const mlb = mlbCache || cache.mlb;
    const kept = loadTracks().filter((t) => {
      const stats = resolvePitcherStats(t, mlb);
      const { settled } = evaluateProp(
        t.side,
        t.line,
        stats?.strikeouts ?? 0,
        stats?.gameStatus || "Preview"
      );
      return !settled;
    });
    saveTracks(kept);
    renderTrack();
  });
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => loadActive(false), REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadActive(false);
});

// boot
updateChromeForTab(activeTab);
loadActive(true);
startPolling();
