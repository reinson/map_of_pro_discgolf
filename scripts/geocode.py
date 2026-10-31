"""Geocode player home towns and event cities with offline GeoNames data.

PDGA lists a player's home as "City, Region, Country" (the municipality they
registered with); we place them at that locality's GeoNames centre point.

Needs geonamescache:  python3 -m pip install --target vendor geonamescache
Manual fixes for anything GeoNames can't resolve go in raw/geo_overrides.json:
  {"<City, Region, Country>": [lat, lon], ...}
"""
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor"))
import geonamescache  # noqa: E402

COUNTRY_ALIASES = {
    "united states": "US", "usa": "US", "czech republic": "CZ", "czechia": "CZ",
    "south korea": "KR", "russia": "RU", "the netherlands": "NL", "netherlands": "NL",
    "great britain": "GB", "united kingdom": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
}
CA_PROVINCES = {"alberta": "01", "british columbia": "02", "manitoba": "03", "new brunswick": "04",
                "newfoundland and labrador": "05", "nova scotia": "07", "ontario": "08",
                "prince edward island": "09", "quebec": "10", "saskatchewan": "11"}


ABBREVIATIONS = {"jct": "junction", "cty": "city", "twp": "township", "mt": "mount", "ft": "fort"}


def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    words = s.lower().replace("-", " ").replace(".", "").replace("'", "").split()
    return " ".join(ABBREVIATIONS.get(w, w) for w in words)


class Geocoder:
    def __init__(self):
        gc = geonamescache.GeonamesCache(min_city_population=500)
        self.countries = {fold(c["name"]): code for code, c in gc.get_countries().items()}
        self.countries.update(COUNTRY_ALIASES)
        self.us_states = {fold(s["name"]): code for code, s in gc.get_us_states().items()}
        self.by_name = {}
        for c in gc.get_cities().values():
            names = {fold(c["name"])} | {fold(a) for a in c.get("alternatenames", []) if a}
            for n in names:
                self.by_name.setdefault((c["countrycode"], n), []).append(c)
        override_path = ROOT / "raw" / "geo_overrides.json"
        self.overrides = json.loads(override_path.read_text()) if override_path.exists() else {}

    def country_code(self, loc):
        if loc.get("country_code"):
            return loc["country_code"].upper()
        return self.countries.get(fold(loc.get("country")))

    def admin_code(self, cc, admin):
        if not admin:
            return None
        first = fold(admin.split(",")[0])
        if cc == "US":
            return self.us_states.get(first) or (admin.upper() if len(admin) == 2 else None)
        if cc == "CA":
            return CA_PROVINCES.get(first)
        return None

    def locate(self, loc, label):
        if label in self.overrides:
            lat, lon = self.overrides[label]
            return dict(lat=lat, lon=lon, method="override")
        cc = self.country_code(loc)
        city = loc.get("city")
        if not cc or not city:
            return None
        # "Lynchburg & Bedford County" -> try each part
        for part in [city] + [p.strip() for p in city.replace("&", "/").split("/") if p.strip() != city]:
            cands = self.by_name.get((cc, fold(part)), [])
            admin = self.admin_code(cc, loc.get("admin"))
            if admin:
                cands = [c for c in cands if c["admin1code"] == admin] or ([] if cc in ("US", "CA") else cands)
            if cands:
                best = max(cands, key=lambda c: c["population"])
                return dict(lat=best["latitude"], lon=best["longitude"], method="geonames",
                            geonameid=best["geonameid"], matched=best["name"], country_code=cc,
                            ambiguous=len({c["geonameid"] for c in cands}) > 1)
        return None


def label_of(loc):
    return ", ".join(p for p in (loc.get("city"), loc.get("admin"), loc.get("country") or loc.get("country_code")) if p)


def main():
    geo = Geocoder()
    data = ROOT / "data"
    players = json.loads((data / "players.json").read_text())
    events = json.loads((data / "events.json").read_text())
    unresolved = []

    for p in players:
        loc = p.get("location")
        if not loc:
            continue
        label = label_of(loc)
        p["location_label"] = label
        p["geo"] = geo.locate(loc, label)
        if not p["geo"]:
            unresolved.append(("player", p["name"], label))

    for e in events:
        parts = [x.strip() for x in (e["location"] or "").split(",")]
        loc = {"city": parts[0], "admin": ", ".join(parts[1:-1]) or None, "country": parts[-1]}
        e["geo"] = geo.locate(loc, e["location"])
        if not e["geo"]:
            unresolved.append(("event", e["slug"], e["location"]))

    (data / "players.json").write_text(json.dumps(players, ensure_ascii=False, indent=1))
    (data / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=1))
    amb = [(p["name"], p["location_label"], p["geo"]["matched"]) for p in players
           if p.get("geo") and p["geo"].get("ambiguous")]
    print("unresolved:", len(unresolved))
    for u in unresolved:
        print("  ", u)
    print("ambiguous (picked most populous):", len(amb))
    for a in amb:
        print("  ", a)


if __name__ == "__main__":
    main()
