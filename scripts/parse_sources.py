"""Parsers for the three raw result formats.

Every parser yields result dicts:
  name, pdga, place, total, to_par, rounds (list of ints), dnf
and records what it learns about players into a shared `people` dict:
  pdga -> {name, location: {city, admin, country, country_code}, avatar}
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"

DIVISIONS = ("MPO", "FPO")
NO_SCORE = {888, 999}
ROUND_COL = re.compile(r"^(Rd\d+|Semis|Finals)$")
PLAYER_LINE = re.compile(r"^\s*(.+?) #(\d+) (?:Professional|Amateur) (.+?)\s*$")
DIVISION_HEADER = re.compile(r"^([A-Z0-9]{2,4}) · .+\(\d+\)\s*$")
AVATAR_BASE = "https://www.pdga.com"


def _int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _to_par(value):
    value = str(value).strip()
    if value == "E":
        return 0
    return _int(value.replace("+", ""))


def _cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _remember(people, pdga, name, location=None, avatar=None, source=None):
    if not pdga:
        return
    person = people.setdefault(pdga, {"pdga": pdga, "name": name, "location": None,
                                      "location_source": None, "avatar": None})
    # md pages carry full region/country names, so they win over live-API codes.
    if location and (person["location"] is None or source == "md"):
        person["location"] = location
        person["location_source"] = source
    if avatar:
        avatar = AVATAR_BASE + avatar if avatar.startswith("/") else avatar
        if not person["avatar"] or _avatar_ts(avatar) > _avatar_ts(person["avatar"]):
            person["avatar"] = avatar


def _avatar_ts(url):
    """PDGA picture files are named picture-<uid>-<unix upload time>.<ext>."""
    m = re.search(r"-(\d+)\.\w+$", url)
    return int(m.group(1)) if m else 0


def _md_location(text):
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        return None
    country = parts[-1]
    city = parts[0] if len(parts) >= 2 else None
    admin = ", ".join(parts[1:-1]) or None
    return {"city": city, "admin": admin, "country": country, "country_code": None}


def parse_md_meta(event_id):
    text = (RAW / "events" / f"{event_id}.md").read_text()
    meta = {}
    m = re.search(r"- Date: (\d{1,2}-\w{3})(?:-(\d{4}))?(?: to (\d{1,2}-\w{3}-\d{4}))?", text)
    if m:
        from datetime import datetime
        end = m.group(3) or f"{m.group(1)}-{m.group(2)}"
        start = f"{m.group(1)}-{end[-4:]}"
        meta["start"] = datetime.strptime(start, "%d-%b-%Y").date().isoformat()
        meta["end"] = datetime.strptime(end, "%d-%b-%Y").date().isoformat()
    m = re.search(r"- Location: (.+)", text)
    if m:
        meta["location"] = m.group(1).strip()
    m = re.search(r"\| Event complete[^|]*\| (\d+) \| ([^|]+) \|", text)
    if m:
        meta["total_players"] = int(m.group(1))
        meta["pro_purse"] = m.group(2).strip()
    return meta


def parse_md(event_id, people, doubles=False):
    """Return {division: [results]} for MPO/FPO tables of a PDGA tour page."""
    lines = (RAW / "events" / f"{event_id}.md").read_text().splitlines()
    out = {}
    division = None
    header = None
    seen_table = set()
    last = None
    for line in lines:
        m = DIVISION_HEADER.match(line)
        if m:
            division, header, last = m.group(1), None, None
            continue
        if division not in DIVISIONS:
            continue
        m = PLAYER_LINE.match(line)
        if m and not line.startswith("|"):
            _remember(people, int(m.group(2)), m.group(1).strip(), _md_location(m.group(3)), source="md")
            continue
        if line.startswith("| Place"):
            # Only the first table under a division header is that division's results.
            header = _cells(line) if division not in seen_table else None
            seen_table.add(division)
            continue
        if header is None or not line.startswith("|") or line.startswith("| ---"):
            if header is not None and not line.startswith("|") and line.strip():
                header = None
            continue
        cells = _cells(line)
        if len(cells) < len(header):
            cells += [""] * (len(header) - len(cells))
        row = dict(zip(header, cells))
        name, pdga = row.get("Name", ""), _int(row.get("PDGA#"))
        place = _int(row.get("Place"))
        if doubles and place is None and last is not None:
            res = dict(last, name=name, pdga=pdga, teammate=last["name"])
            last["teammate"] = name
            out[division].append(res)
            _remember(people, pdga, name)
            continue
        rounds = []
        for i, col in enumerate(header):
            if ROUND_COL.match(col):
                v = _int(cells[i])
                if v is not None and v not in NO_SCORE:
                    rounds.append(v)
        total_raw = row.get("Total", "")
        dnf = total_raw.upper() == "DNF" or any(_int(cells[i]) in NO_SCORE
                                               for i, c in enumerate(header) if ROUND_COL.match(c))
        res = dict(name=name, pdga=pdga, place=place, total=None if dnf else _int(total_raw),
                   to_par=None if dnf else _to_par(row.get("Par", "")), rounds=rounds, dnf=dnf)
        out.setdefault(division, []).append(res)
        _remember(people, pdga, name)
        last = res
    return out


def _live_scores(filename):
    data = json.loads((RAW / "live" / filename).read_text())["data"]
    if isinstance(data, list):
        data = data[0]
    return data["scores"]


def _live_rounds(score):
    vals = [_int(v) for v in (score.get("Rounds") or "").split(",")]
    rounds = [v for v in vals if v is not None and v not in NO_SCORE]
    dnf = any(v in NO_SCORE for v in vals if v is not None)
    return rounds, dnf


def _remember_live(people, s):
    loc = None
    if s.get("City") or s.get("Country"):
        loc = {"city": s.get("City"), "admin": s.get("StateProv"), "country": None,
               "country_code": s.get("Country")}
    _remember(people, s.get("PDGANum"), s["Name"], loc, s.get("AvatarURL"), source="live")


def parse_live(files, people):
    """Later files (e.g. finals) override earlier ones for the players they contain."""
    by_key = {}
    for filename in files:
        for s in _live_scores(filename):
            _remember_live(people, s)
            rounds, dnf = _live_rounds(s)
            grand = _int(s.get("GrandTotal"))
            if grand in NO_SCORE or (grand and grand >= 888):
                dnf = True
            key = s.get("PDGANum") or s["Name"]
            by_key[key] = dict(name=s["Name"], pdga=s.get("PDGANum"), place=_int(s.get("RunningPlace")),
                               total=None if dnf else grand, to_par=None if dnf else _int(s.get("ToPar")),
                               rounds=rounds, dnf=dnf)
    return list(by_key.values())


def parse_csv(filename, people, rounds_file=None):
    live = {}
    if rounds_file:
        for s in _live_scores(rounds_file):
            _remember_live(people, s)
            live[s.get("PDGANum")] = _live_rounds(s)[0]
    out = []
    with open(RAW / "events" / filename, newline="") as fh:
        for row in csv.DictReader(fh):
            pdga = _int(row["pdga"])
            dnf = row["total"].strip().upper() == "DNF"
            loc = None
            if row.get("city"):
                loc = {"city": row["city"], "admin": None, "country": None, "country_code": row.get("country")}
            _remember(people, pdga, row["name"], loc, row.get("avatar") or None, source="live")
            out.append(dict(name=row["name"], pdga=pdga, place=_int(row["place"]),
                            total=None if dnf else _int(row["total"]),
                            to_par=None if dnf else _to_par(row["to_par"]),
                            rounds=live.get(pdga, []), dnf=dnf))
    return out
