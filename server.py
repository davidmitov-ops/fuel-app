#!/usr/bin/env python3
"""Cheap Fuel AU. Tiny server: state price feeds in, one clean JSON API out.

Providers
  NSW  FuelCheck API v1   (free key, config.json -> nsw_api_key)
  QLD  data.qld.gov.au    (keyless, monthly files merged, latest price wins)
  WA   FuelWatch RSS      (keyless, today's prices)
  TAS  via NSW FuelCheck v2 when key present (handled by nsw provider flag)

Run:  python3 server.py   (default port 8788)
"""
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8788"))

def load_config():
    p = os.path.join(HERE, "config.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {}

CONFIG = load_config()


NSW_CACHE = {"stations": None, "ts": 0}
NSW_TTL = 300  # 5 min; real-time feel, ~9k calls/month worst case, typical far less

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"

def _get(url, headers=None, retries=2, timeout=60):
    h = {"User-Agent": UA}
    h.update(headers or {})
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2)
    raise last

def _get_json(url, headers=None):
    return json.loads(_get(url, headers))

# ---------------- NSW / TAS (FuelCheck via api.onegov.nsw.gov.au) ----------------

NSW_TOKEN = {"tok": None, "ts": 0}

def _nsw_headers():
    import base64
    key, sec = CONFIG["nsw_api_key"], CONFIG["nsw_api_secret"]
    now = time.time()
    if not NSW_TOKEN["tok"] or now - NSW_TOKEN["ts"] > 11 * 3600:
        basic = base64.b64encode(f"{key}:{sec}".encode()).decode()
        url = "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials"
        d = _get_json(url, headers={"Authorization": "Basic " + basic, "Accept": "application/json"})
        NSW_TOKEN["tok"] = d["access_token"]
        NSW_TOKEN["ts"] = now
    return {
        "Authorization": "Bearer " + NSW_TOKEN["tok"],
        "apikey": key,
        "transactionid": "cheapfuel-%d" % int(now),
        "requesttimestamp": time.strftime("%d/%m/%Y %I:%M:%S %p"),
        "Accept": "application/json",
    }

NSW_FUEL_MAP = {"E10": "U91", "U91": "U91", "P95": "U95", "P98": "U98",
                "DL": "DL", "PD": "PDSL", "PDiesel": "PDSL", "LPG": "LPG",
                "CNG": "LPG", "B20": "B20", "EV": "EV"}

def nsw_available():
    return bool(CONFIG.get("nsw_api_key") and CONFIG.get("nsw_api_secret"))

def nsw_stations():
    now = time.time()
    if NSW_CACHE["stations"] and now - NSW_CACHE["ts"] < NSW_TTL:
        return NSW_CACHE["stations"]
    H = dict(_nsw_headers(), **{"User-Agent": UA})
    d = _get_json("https://api.onegov.nsw.gov.au/FuelPriceCheck/v1/fuel/prices", headers=H)
    out = {}
    for st in d.get("stations", []):
        loc = st.get("location") or {}
        out[st.get("code")] = {
            "id": "nsw-%s" % st.get("code"),
            "name": st.get("name"),
            "brand": st.get("brand"),
            "address": st.get("address"),
            "suburb": (st.get("address") or "").split(",")[-1].strip(),
            "postcode": "",
            "state": "NSW",
            "lat": loc.get("latitude"), "lng": loc.get("longitude"),
            "prices": {},
        }
    for p in d.get("prices", []):
        st = out.get(p.get("stationcode"))
        if not st:
            continue
        fuel = NSW_FUEL_MAP.get(p.get("fueltype"), p.get("fueltype"))
        st["prices"][fuel] = {"price": p.get("price"), "updated": p.get("lastupdated") or ""}
    # Tasmania rides along in v2; keep only NSW for now
    res = [s for s in out.values() if s["lat"] and s["lng"]]
    NSW_CACHE["stations"] = res
    NSW_CACHE["ts"] = now
    return res

# ---------------- QLD (keyless) ----------------

QLD_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
              "august", "september", "october", "november", "december"]

# canonical: U91 U95 U98 DL LPG E85
QLD_FUEL_MAP = {
    "Unleaded": "U91", "e10": "U91", "OPAL": "U91",
    "PULP 95/96 RON": "U95", "PULP 98 RON": "U98",
    "Diesel": "DL", "Premium Diesel": "PDSL", "LPG": "LPG", "e85": "E85",
}

QLD_CACHE = {"stations": None, "ts": 0}
QLD_TTL = 6 * 3600  # monthly data: refresh every 6h is plenty
QLD_MONTHS_CACHE = []
QLD_LAST_ERROR = ""

def _month_from_name(name):
    low = name.lower()
    for i, m in enumerate(QLD_MONTHS, 1):
        if m in low:
            return i
    return None

def qld_month_resources():
    global QLD_MONTHS_CACHE, QLD_LAST_ERROR
    found = {}
    for year in ("2026", "2025"):
        try:
            d = _get_json("https://www.data.qld.gov.au/api/3/action/package_show?id=fuel-price-reporting-%s" % year)
        except Exception as e:  # noqa: BLE001
            QLD_LAST_ERROR = "package %s: %r" % (year, e)
            continue
        if not d.get("success"):
            continue
        for res in d["result"]["resources"]:
            if res["format"] != "CSV":
                continue
            m = _month_from_name(res["name"])
            if m:
                found[(int(year), m)] = res["id"]
    QLD_MONTHS_CACHE = sorted(found.keys(), reverse=True)
    return sorted(found.items(), key=lambda kv: kv[0], reverse=True)

def qld_fetch_month(resource_id):
    rows, offset, limit = [], 0, 25000
    while True:
        q = urllib.parse.urlencode({"resource_id": resource_id, "limit": limit, "offset": offset})
        d = _get_json("https://www.data.qld.gov.au/api/3/action/datastore_search?" + q)
        if not d.get("success"):
            break
        recs = d["result"]["records"]
        rows.extend(r for r in recs if r.get("Site_Latitude"))
        if len(rec) if False else len(recs) < limit:
            break
        offset += limit
    return rows

def qld_stations():
    now = time.time()
    if QLD_CACHE["stations"] and now - QLD_CACHE["ts"] < QLD_TTL:
        return QLD_CACHE["stations"]

    prices, meta = {}, {}
    for (year, month), rid in qld_month_resources()[:3]:
        for r in qld_fetch_month(rid):
            sid = r["SiteId"]
            meta.setdefault(sid, {
                "name": r.get("Site_Name"), "brand": r.get("Site_Brand"),
                "address": r.get("Sites_Address_Line_1"), "suburb": r.get("Site_Suburb"),
                "postcode": r.get("Site_Post_Code"),
                "lat": float(r["Site_Latitude"]), "lng": float(r["Site_Longitude"]),
            })
            ts = r.get("TransactionDateutc") or ""
            fuel = QLD_FUEL_MAP.get(r["Fuel_Type"], r["Fuel_Type"])
            key = (sid, fuel)
            prev = prices.get(key)
            if not prev or str(ts) > str(prev[0]):
                prices[key] = (str(ts), round(r["Price"] / 10.0, 1))

    out = {}
    for (sid, fuel), (ts, price) in prices.items():
        st = out.setdefault(sid, dict(meta[sid], id="qld-%s" % sid, state="QLD", prices={}))
        st["prices"][fuel] = {"price": price, "updated": ts}
    QLD_CACHE["stations"] = list(out.values())
    QLD_CACHE["ts"] = now
    return QLD_CACHE["stations"]

# ---------------- WA (FuelWatch RSS, keyless) ----------------

WA_PRODUCTS = {"1": "U91", "2": "U95", "3": "U98", "4": "DL", "5": "LPG", "6": "E85"}
WA_FUEL_TO_PRODUCT = {"U91": "1", "U95": "2", "U98": "3", "DL": "4", "LPG": "5", "E85": "6"}
WA_CACHE = {}  # product -> (ts, stations)
WA_TTL = 3600

def wa_stations_all():
    """All WA products, one fetch each, cached."""
    now = time.time()
    stations, index = {}, {}
    for prod, fuel in WA_PRODUCTS.items():
        cached = WA_CACHE.get(prod)
        if cached and now - cached[0] < WA_TTL:
            rows = cached[1]
        else:
            rows = wa_fetch_product(prod)
            WA_CACHE[prod] = (now, rows)
        for r in rows:
            sid = "%s-%s" % (r["brand"], r["address"])
            st = stations.setdefault(sid, {
                "id": "wa-%s" % abs(hash(sid)), "name": r["name"], "brand": r["brand"],
                "address": r["address"], "suburb": r["suburb"], "postcode": "",
                "state": "WA", "lat": r["lat"], "lng": r["lng"], "prices": {}})
            st["prices"][fuel] = {"price": r["price"], "updated": r["date"]}
    return list(stations.values())

def wa_fetch_product(product):
    url = "https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=%s" % product
    root = ET.fromstring(_get(url).decode("utf-8-sig"))
    out = []
    for it in root.iter("item"):
        try:
            out.append({
                "name": (it.findtext("trading-name") or "").strip(),
                "brand": (it.findtext("brand") or "").strip(),
                "address": (it.findtext("address") or "").strip(),
                "suburb": (it.findtext("location") or "").strip().title(),
                "lat": float(it.findtext("latitude")),
                "lng": float(it.findtext("longitude")),
                "price": float(it.findtext("price")),
                "date": (it.findtext("date") or "").strip(),
            })
        except (TypeError, ValueError):
            continue
    return out

# ---------------- merge + query ----------------

def all_stations():
    stations = []
    if nsw_available():
        try:
            stations += nsw_stations()
        except Exception as e:  # noqa: BLE001
            print("NSW failed:", e)
    for fn in (qld_stations, wa_stations_all):
        try:
            stations += fn()
        except Exception as e:  # noqa: BLE001
            print(fn.__name__, "failed:", e)
    return stations

def haversine(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

def nearby(lat, lng, fuel, km):
    fuel = fuel.upper()
    res = []
    for s in all_stations():
        if not s.get("lat") or not s.get("lng"):
            continue
        price = None
        fuel_key = None
        for cand in (fuel, "E10" if fuel == "U91" else None, "Unleaded" if fuel == "U91" else None,
                     "Diesel" if fuel == "DL" else None):
            if cand and cand in s["prices"]:
                price = s["prices"][cand]["price"]
                fuel_key = cand
                break
        if price is None:
            continue
        d = haversine(lat, lng, float(s["lat"]), float(s["lng"]))
        if d > km:
            continue
        res.append({"id": s["id"], "name": s["name"], "brand": s["brand"],
                    "address": s["address"], "suburb": s["suburb"], "state": s["state"],
                    "lat": float(s["lat"]), "lng": float(s["lng"]),
                    "updated": s["prices"][fuel_key]["updated"] if fuel_key else "",
                    "distance_km": round(d, 1), "price": price})
    res.sort(key=lambda x: (x["price"], x["distance_km"]))
    return res[:40], len(res)

# ---------------- HTTP ----------------

CTYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript",
          ".css": "text/css", ".json": "application/manifest+json",
          ".png": "image/png", ".webmanifest": "application/manifest+json"}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    # crude per-IP rate limit: 60 req/min, enough for humans, deters scrapers
    _HITS = {}
    def _rate_ok(self):
        now = time.time()
        ip = self.client_address[0]
        hits = Handler._HITS.setdefault(ip, [])
        hits[:] = [t for t in hits if now - t < 60]
        if len(hits) >= 60:
            return False
        hits.append(now)
        return True

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if not self._rate_ok():
            self._send(429, b"slow down", "text/plain")
            return
        try:
            if parsed.path == "/api/stations":
                q = urllib.parse.parse_qs(parsed.query)
                lat, lng = float(q["lat"][0]), float(q["lng"][0])
                fuel = (q.get("fuel") or ["U91"])[0]
                km = float((q.get("km") or ["5"])[0])
                results, total = nearby(lat, lng, fuel, km)
                body = json.dumps({"results": results, "total": total}).encode()
                self._send(200, body, "application/json")
                return
            if parsed.path == "/api/status":
                body = json.dumps({
                    "nsw_key": nsw_available(),
                    "nsw_cached": bool(NSW_CACHE["stations"]),
                    "qld_cached": len(QLD_CACHE["stations"] or []),
                    "qld_months": [list(k) for k in QLD_MONTHS_CACHE] if QLD_MONTHS_CACHE else [],
                    "qld_error": QLD_LAST_ERROR,
                }).encode()
                self._send(200, body, "application/json")
                return

            if parsed.path.startswith("/api/") or parsed.path == "/favicon.ico":
                self._send(404, b"{}", "application/json")
                return

            fname = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
            path = os.path.join(HERE, "static", os.path.basename(fname))
            if os.path.exists(path):
                ext = os.path.splitext(path)[1]
                with open(path, "rb") as f:
                    self._send(200, f.read(), CTYPES.get(ext, "text/plain"))
                return
            self._send(404, b"not found", "text/plain")
        except Exception as e:  # noqa: BLE001
            self._send(500, str(e).encode(), "text/plain")

if __name__ == "__main__":
    threading.Thread(target=qld_stations, daemon=True).start()
    print("Cheap Fuel AU on http://0.0.0.0:%d" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
