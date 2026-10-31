"""Write web/public/season.json: the compact dataset the map app loads.

Results are stored as arrays to keep the file small:
  [place, tied, name, pdga, total, to_par, strokes_behind, rounds_played, behind_basis_round, dnf, teammate]
behind_basis_round is null when strokes_behind is measured against the final
winning total, else the round after which the gap to the leader was taken.
"""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "web" / "public" / "season.json"


def main():
    events = json.loads((DATA / "events.json").read_text())
    players = json.loads((DATA / "players.json").read_text())
    results = json.loads((DATA / "results.json").read_text())

    by_event = {}
    for r in results:
        by_event.setdefault(r["event"], {}).setdefault(r["division"], []).append(r)

    out_results = {}
    for slug, divs in by_event.items():
        out_results[slug] = {}
        for div, rows in divs.items():
            places = Counter(r["place"] for r in rows if not r["dnf"])
            if any(r.get("teammate") for r in rows):
                # doubles: two rows per team share a place
                places = Counter({p: c // 2 for p, c in places.items()})
            packed = []
            for r in rows:
                basis = r.get("strokes_behind_basis")
                packed.append([
                    r["place"], places.get(r["place"], 0) > 1 and not r["dnf"], r["name"], r["pdga"],
                    r["total"], r["to_par"], r.get("strokes_behind"), r.get("rounds_played"),
                    int(basis.rsplit("_", 1)[1]) if basis and basis.startswith("after_round") else None,
                    r["dnf"], r.get("teammate"),
                ])
            out_results[slug][div] = packed

    out_events = []
    for e in events:
        out_events.append(dict(
            slug=e["slug"], name=e["name"], series=e["series"], division_series=e["division_series"],
            start=e["start"], end=e["end"],
            location=e["location"], lat=e["geo"]["lat"], lon=e["geo"]["lon"],
            upcoming=e["upcoming"], doubles=e["doubles"], note=e["note"],
            pdga=e["pdga_event_ids"], divisions=e["divisions"],
        ))

    out_players = []
    for p in players:
        out_players.append(dict(
            pdga=p["pdga"], division=p["division"], rank=p["rank"], name=p["name"],
            points=p["points"], starts=p["starts"], wins=p["wins"], top10s=p["top10s"],
            home=p["location_label"], lat=p["geo"]["lat"], lon=p["geo"]["lon"],
            avatar=p["avatar"], profile=p["profile_url"],
        ))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dict(
        season=2026, standings_as_of="2026-09-30",
        events=out_events, players=out_players, results=out_results,
    ), ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
