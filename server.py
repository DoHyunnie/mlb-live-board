"""
MLB Live Board — local server
Serves the scoreboard UI and aggregates live scores + starting pitcher Ks
from the free MLB Stats API (statsapi.mlb.com).
"""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

MLB_API = "https://statsapi.mlb.com/api/v1"
STATIC_DIR = Path(__file__).resolve().parent / "static"
CACHE_TTL_SECONDS = 15
PT = ZoneInfo("America/Los_Angeles")  # Pacific Time (PST/PDT)

_cache_lock = threading.Lock()
_cache: dict = {"key": None, "ts": 0.0, "payload": None}


def mlb_get(path: str, params: dict | None = None) -> dict:
    query = ""
    if params:
        parts = []
        for k, v in params.items():
            if v is None:
                continue
            parts.append(f"{k}={v}")
        if parts:
            query = "?" + "&".join(parts)
    url = f"{MLB_API}/{path.lstrip('/')}{query}"
    req = Request(url, headers={"User-Agent": "mlb-live-board/1.0", "Accept": "application/json"})
    with urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode("utf-8"))


def today_pt() -> str:
    return datetime.now(PT).strftime("%Y-%m-%d")


def pitcher_line(team_box: dict, pitcher_id: int | None) -> dict | None:
    if not pitcher_id:
        return None
    players = team_box.get("players") or {}
    player = players.get(f"ID{pitcher_id}") or {}
    person = player.get("person") or {}
    pitching = (player.get("stats") or {}).get("pitching") or {}

    def as_int(key: str, default: int = 0) -> int:
        try:
            return int(pitching.get(key, default) or default)
        except (TypeError, ValueError):
            return default

    return {
        "id": pitcher_id,
        "name": person.get("fullName") or "TBD",
        "strikeouts": as_int("strikeOuts"),
        "inningsPitched": pitching.get("inningsPitched") or "0.0",
        "pitches": as_int("numberOfPitches") or as_int("pitchesThrown"),
        "walks": as_int("baseOnBalls"),
        "hits": as_int("hits"),
        "earnedRuns": as_int("earnedRuns"),
        "note": pitching.get("note") or "",
        "summary": pitching.get("summary") or "",
    }


def extract_starter(team_box: dict, probable_id: int | None) -> dict | None:
    """Prefer probable starter if they pitched; else first pitcher listed (actual starter)."""
    pitchers = team_box.get("pitchers") or []
    if not pitchers:
        # Pre-game: only probable is available
        if probable_id:
            return {
                "id": probable_id,
                "name": None,  # filled from schedule
                "strikeouts": 0,
                "inningsPitched": "0.0",
                "pitches": 0,
                "walks": 0,
                "hits": 0,
                "earnedRuns": 0,
                "note": "",
                "summary": "",
                "pregame": True,
            }
        return None

    starter_id = pitchers[0]
    if probable_id and probable_id in pitchers:
        starter_id = probable_id

    line = pitcher_line(team_box, starter_id)
    if line:
        line["pregame"] = False
    return line


def fetch_boxscore(game_pk: int) -> dict | None:
    try:
        return mlb_get(f"game/{game_pk}/boxscore")
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def build_side(team_block: dict, side_box: dict | None, score_fallback: int | None) -> dict:
    team = team_block.get("team") or {}
    probable = (team_block.get("probablePitcher") or {})
    probable_id = probable.get("id")
    probable_name = probable.get("fullName")

    starter = None
    if side_box is not None:
        starter = extract_starter(side_box, probable_id)
        if starter and not starter.get("name"):
            starter["name"] = probable_name or "TBD"
    elif probable_id or probable_name:
        starter = {
            "id": probable_id,
            "name": probable_name or "TBD",
            "strikeouts": 0,
            "inningsPitched": "0.0",
            "pitches": 0,
            "walks": 0,
            "hits": 0,
            "earnedRuns": 0,
            "note": "",
            "summary": "",
            "pregame": True,
        }

    score = team_block.get("score")
    if score is None:
        score = score_fallback

    record = team_block.get("leagueRecord") or {}
    return {
        "id": team.get("id"),
        "name": team.get("name") or "TBD",
        "abbreviation": team.get("abbreviation") or team.get("teamName") or "",
        "score": score if score is not None else 0,
        "wins": record.get("wins"),
        "losses": record.get("losses"),
        "isWinner": bool(team_block.get("isWinner")),
        "starter": starter,
    }


def enrich_game(game: dict) -> dict:
    status = game.get("status") or {}
    abstract = status.get("abstractGameState") or "Preview"
    detailed = status.get("detailedState") or abstract
    linescore = game.get("linescore") or {}
    teams = game.get("teams") or {}
    away_block = teams.get("away") or {}
    home_block = teams.get("home") or {}

    game_pk = game.get("gamePk")
    need_box = abstract in ("Live", "Final") or detailed not in ("Scheduled", "Pre-Game", "Warmup")
    box = fetch_boxscore(game_pk) if need_box and game_pk else None
    away_box = (box or {}).get("teams", {}).get("away") if box else None
    home_box = (box or {}).get("teams", {}).get("home") if box else None

    # Pre-game: still fill probable names even without boxscore
    if abstract == "Preview" or detailed in ("Scheduled", "Pre-Game", "Warmup", "Delayed Start", "Postponed"):
        away_box = away_box  # may be None
        home_box = home_box

    ls_teams = linescore.get("teams") or {}
    away_runs = (ls_teams.get("away") or {}).get("runs")
    home_runs = (ls_teams.get("home") or {}).get("runs")

    inning_label = None
    if abstract == "Live":
        state = linescore.get("inningState") or ""
        ordinal = linescore.get("currentInningOrdinal") or ""
        inning_label = f"{state} {ordinal}".strip()
    elif abstract == "Final":
        innings = linescore.get("currentInning") or 9
        inning_label = "Final" if innings <= 9 else f"Final/{innings}"

    venue = (game.get("venue") or {}).get("name") or ""
    game_date = game.get("gameDate") or ""
    local_time = ""
    start_ts = 0.0  # for chronological sort
    if game_date:
        try:
            dt = datetime.fromisoformat(game_date.replace("Z", "+00:00")).astimezone(PT)
            local_time = dt.strftime("%I:%M %p PT").lstrip("0")
            start_ts = dt.timestamp()
        except ValueError:
            local_time = ""

    away = build_side(away_block, away_box, away_runs)
    home = build_side(home_block, home_box, home_runs)

    # Ensure abbreviations from team names if missing
    for side in (away, home):
        if not side.get("abbreviation") and side.get("name"):
            parts = side["name"].split()
            side["abbreviation"] = parts[-1][:3].upper() if parts else "???"

    return {
        "gamePk": game_pk,
        "status": abstract,
        "detailedState": detailed,
        "inningLabel": inning_label or detailed,
        "balls": linescore.get("balls"),
        "strikes": linescore.get("strikes"),
        "outs": linescore.get("outs"),
        "venue": venue,
        "gameTime": local_time,
        "gameDate": game.get("officialDate") or "",
        "startTs": start_ts,
        "away": away,
        "home": home,
    }


def get_games(date_str: str | None = None) -> dict:
    date_str = date_str or today_pt()
    now = time.time()

    with _cache_lock:
        if _cache["key"] == date_str and _cache["payload"] is not None and (now - _cache["ts"]) < CACHE_TTL_SECONDS:
            return _cache["payload"]

    schedule = mlb_get(
        "schedule",
        {
            "sportId": 1,
            "date": date_str,
            "hydrate": "linescore,probablePitcher,team",
        },
    )

    raw_games = []
    for day in schedule.get("dates") or []:
        raw_games.extend(day.get("games") or [])

    games: list[dict] = []
    # Parallel boxscore fetches
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(enrich_game, g): g for g in raw_games}
        for fut in as_completed(futures):
            try:
                games.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                g = futures[fut]
                games.append(
                    {
                        "gamePk": g.get("gamePk"),
                        "status": "Preview",
                        "detailedState": f"Error: {exc}",
                        "inningLabel": "Unavailable",
                        "startTs": 0.0,
                        "gameTime": "",
                        "away": {"name": "Away", "score": 0, "starter": None},
                        "home": {"name": "Home", "score": 0, "starter": None},
                        "error": str(exc),
                    }
                )

    # Chronological order by first pitch (Pacific time)
    games.sort(key=lambda g: (g.get("startTs") or 0.0, g.get("gamePk") or 0))

    payload = {
        "date": date_str,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "gameCount": len(games),
        "games": games,
    }

    with _cache_lock:
        _cache["key"] = date_str
        _cache["ts"] = now
        _cache["payload"] = payload

    return payload


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        # Quieter console
        if args and str(args[0]).startswith("GET /api/"):
            return
        super().log_message(fmt, *args)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in ("/api/games", "/api/games/"):
            qs = parse_qs(parsed.query)
            date = (qs.get("date") or [None])[0]
            try:
                payload = get_games(date)
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:  # noqa: BLE001
                err = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(err)))
                self.end_headers()
                self.wfile.write(err)
            return

        if parsed.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()


def main() -> None:
    port = 8765
    # 0.0.0.0 = reachable from phone / other devices on the same Wi‑Fi
    host = "0.0.0.0"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"MLB Live Board")
    print(f"  This PC:  http://127.0.0.1:{port}")
    print(f"  Phone:    http://<this-pc-lan-ip>:{port}  (same Wi‑Fi)")
    print("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
