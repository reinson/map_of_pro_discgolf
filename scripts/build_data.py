"""Consolidate raw sources into data/events.json, data/results.json, data/players.json.

Run from the project root:  python3 scripts/build_data.py
"""
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from events_config import EVENTS  # noqa: E402
from parse_sources import (RAW, ROOT, _live_scores, _remember_live, parse_csv, parse_live,  # noqa: E402
                           parse_md, parse_md_meta)

DATA = ROOT / "data"
TOP_N = 100


def add_strokes_behind(results):
    """Strokes behind the winner; for players with fewer rounds (missed cut / DNF),
    strokes behind the leader after the same number of rounds."""
    finishers = [r for r in results if not r["dnf"] and r["total"] is not None]
    if not finishers:
        return
    winner = min(finishers, key=lambda r: (r["place"] or 999, r["total"]))
    max_rounds = len(winner["rounds"])
    best_after = {}
    for r in results:
        cum = 0
        for k, score in enumerate(r["rounds"], 1):
            cum += score
            best_after[k] = min(best_after.get(k, cum), cum)
    for r in results:
        n = len(r["rounds"])
        if not r["dnf"] and r["total"] is not None and (n == max_rounds or not r["rounds"]):
            r["strokes_behind"] = r["total"] - winner["total"]
            r["strokes_behind_basis"] = "final"
        elif n:
            r["strokes_behind"] = sum(r["rounds"]) - best_after[n]
            r["strokes_behind_basis"] = f"after_round_{n}"
        else:
            r["strokes_behind"] = None
            r["strokes_behind_basis"] = None
        r["rounds_played"] = n


def norm_name(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z ]", "", name.lower().replace("-", " ")).split()


def load_standings(division):
    if division == "MPO":
        rows = []
        for line in (RAW / "standings" / "statmando_mpo.md").read_text().splitlines():
            c = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(c) >= 9 and c[0].isdigit():
                rows.append(dict(rank=int(c[0]), name=c[2].rstrip("*"), points=float(c[3]),
                                 starts=int(c[5]), wins=int(c[6]), top10s=int(c[7]), cashed=int(c[8]),
                                 auto_qualified=c[2].endswith("*")))
    else:
        with open(RAW / "standings" / "statmando_fpo_top100.csv", newline="") as fh:
            rows = [dict(rank=int(r["rank"]), name=r["name"], points=float(r["points"]),
                         starts=int(r["starts"]), wins=int(r["wins"]), top10s=int(r["top10s"]),
                         cashed=int(r["cashed"])) for r in csv.DictReader(fh)]
    return [r for r in rows if r["rank"] <= TOP_N]


def main():
    people = {}
    events_out, results_out = [], []
    for ev in EVENTS:
        meta = {}
        divisions = {}
        for src in ev["sources"]:
            kind = src[0]
            if kind == "md":
                meta = parse_md_meta(src[1])
                for div, res in parse_md(src[1], people, doubles=ev.get("doubles", False)).items():
                    divisions[div] = res
            elif kind == "live":
                divisions[src[1]] = parse_live(src[2:], people)
            elif kind == "csv":
                divisions[src[1]] = parse_csv(src[2], people, src[3] if len(src) > 3 else None)
        record = dict(
            slug=ev["slug"], name=ev["name"], series=ev["series"],
            division_series=ev.get("division_series", {}), pdga_event_ids=ev["pdga"],
            start=meta.get("start", ev.get("start")), end=meta.get("end", ev.get("end")),
            location=meta.get("location", ev.get("location")),
            upcoming=ev.get("upcoming", False), doubles=ev.get("doubles", False),
            note=ev.get("note"), pdga_title=None, divisions={},
        )
        if ev["pdga"]:
            first = (RAW / "events" / f"{ev['pdga'][0]}.md")
            if first.exists():
                record["pdga_title"] = first.read_text().split(" | Professional Disc Golf")[0].split("\n")[-1].strip()
        for div, res in divisions.items():
            res.sort(key=lambda r: (r["dnf"], r["place"] if r["place"] is not None else 9999))
            add_strokes_behind(res)
            winner = next((r for r in res if not r["dnf"]), None)
            record["divisions"][div] = dict(players=len(res), winner=winner["name"] if winner else None,
                                            winner_pdga=winner["pdga"] if winner else None,
                                            winning_total=winner["total"] if winner else None,
                                            winning_to_par=winner["to_par"] if winner else None)
            for r in res:
                results_out.append(dict(event=ev["slug"], division=div, **r))
        events_out.append(record)

    # Every live file (including ones fetched only for avatars) can fill player info.
    for path in sorted((RAW / "live").glob("*.json")):
        for s in _live_scores(path.name):
            _remember_live(people, s)

    # Standings: match names to PDGA numbers using every name seen in results.
    by_name = {}
    for r in results_out:
        if r["pdga"]:
            by_name.setdefault((r["division"], " ".join(norm_name(r["name"]))), set()).add(r["pdga"])
    players_out, unmatched = [], []
    for div in ("MPO", "FPO"):
        for s in load_standings(div):
            key = (div, " ".join(norm_name(s["name"])))
            cands = by_name.get(key, set())
            if not cands:
                # fall back to first+last token match (handles middle names / initials)
                toks = norm_name(s["name"])
                cands = {p for (d, n), ps in by_name.items() if d == div
                         and n.split()[0] == toks[0] and n.split()[-1] == toks[-1] for p in ps}
            pdga = next(iter(cands)) if len(cands) == 1 else None
            if pdga is None:
                unmatched.append((div, s["name"], sorted(cands)))
            person = people.get(pdga, {})
            players_out.append(dict(division=div, **s, pdga=pdga,
                                    pdga_name=person.get("name"),
                                    location=person.get("location"),
                                    location_source=person.get("location_source"),
                                    avatar=person.get("avatar"),
                                    profile_url=f"https://www.pdga.com/player/{pdga}" if pdga else None))

    DATA.mkdir(exist_ok=True)
    (DATA / "events.json").write_text(json.dumps(events_out, ensure_ascii=False, indent=1))
    (DATA / "results.json").write_text(json.dumps(results_out, ensure_ascii=False, indent=1))
    (DATA / "players.json").write_text(json.dumps(players_out, ensure_ascii=False, indent=1))

    print(f"events: {len(events_out)}, result rows: {len(results_out)}, players: {len(players_out)}")
    for e in events_out:
        divs = ", ".join(f"{d}:{v['players']} won by {v['winner']} ({v['winning_to_par']:+d}, {v['winning_total']})"
                         if v["winning_to_par"] is not None else f"{d}:{v['players']}"
                         for d, v in e["divisions"].items())
        print(f"  {e['start']} {e['slug']:<28} {e['location']!s:<45} {divs}")
    print("unmatched standings names:", unmatched)
    print("top-100 without avatar:", sum(1 for p in players_out if not p["avatar"]),
          "without location:", sum(1 for p in players_out if not p["location"]))

    import geocode
    geocode.main()
    import export_web
    export_web.main()


if __name__ == "__main__":
    main()
