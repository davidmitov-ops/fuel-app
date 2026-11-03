/* Cheap Fuel AU front end */
let fuel = localStorage.fuel || "U91";
let km = localStorage.km || "5";
let coords = null;

const $ = (s) => document.querySelector(s);
const list = $("#list");

function render(results) {
  list.innerHTML = "";
  $("#empty").classList.toggle("hidden", results.length > 0);
  const best = results.length ? results[0].price : null;
  for (const r of results) {
    const div = document.createElement("div");
    div.className = "card" + (r.price === best ? " best" : "");
    div.innerHTML =
      '<div class="info">' +
      '<div class="name">' + esc(r.brand || r.name || "?") +
      (r.name && r.brand && r.name !== r.brand ? "" : "") + "</div>" +
      '<div class="addr">' + esc(r.address || "") + (r.suburb ? ", " + esc(r.suburb) : "") + "</div>" +
      '<div class="dist">' + r.distance_km + " km" + (r.state ? " &middot; " + r.state : "") +
      (ageStr(r.updated) ? ' &middot; price set ' + ageStr(r.updated) : '') + "</div>" +
      "</div>" +
      '<div class="price">' + r.price.toFixed(1) + "<span style='font-size:12px;font-weight:400'> c/L</span></div>";
    div.addEventListener("click", () => {
      const q = encodeURIComponent((r.address || "") + " " + (r.suburb || ""));
      window.open("https://www.google.com/maps/search/?api=1&query=" + r.lat + "," + r.lng, "_blank");
    });
    list.appendChild(div);
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function ageStr(ts) {
  if (!ts) return '';
  let d;
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  else { const m = ts.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/); if (!m) return ''; d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0) || 0, 0); }
  const mins = Math.round((Date.now() - d.getTime()) / 60000) - (new Date().getTimezoneOffset() * 0);
  if (isNaN(mins)) return '';
  if (mins < 90) return mins + ' min ago';
  const h = Math.round(mins / 60); if (h < 36) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}

async function load() {
  if (!coords) return;
  $("#status").textContent = "loading prices…";
  const btn = $("#refresh");
    btn.classList.add("spin");
  try {
    const q = new URLSearchParams({ lat: coords.lat, lng: coords.lng, fuel, km });
    const r = await fetch("/api/stations?" + q);
    const d = await r.json();
    render(d.results || []);
    $("#status").textContent = d.total + " stations within " + km + " km";
  } catch (e) {
    $("#status").textContent = "couldn't load prices";
  } finally {
    btn.classList.remove("spin");
  }
}

function locate() {
  $("#status").textContent = "finding you…";
  if (!navigator.geolocation) { $("#status").textContent = "no GPS in this browser"; return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      coords = { lat: p.coords.latitude, lng: p.coords.longitude };
      localStorage.coords = JSON.stringify(coords);
      load();
    },
    (err) => {
      $("#status").textContent = "location denied, using last known";
      try { coords = JSON.parse(localStorage.coords); load(); } catch (_) {}
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

// chips
document.querySelectorAll("#fuelChips button").forEach((b) => {
  if (b.dataset.fuel === fuel) { b.classList.add("on"); document.querySelectorAll("#fuelChips button").forEach((x) => x !== b && x.classList.remove("on")); }
  b.onclick = () => {
    fuel = b.dataset.fuel; localStorage.fuel = fuel;
    syncFuelChips();
    load();
  };
});
document.querySelectorAll("#kmChips button").forEach((b) => {
  if (b.dataset.km === String(km)) b.classList.add("on");
  b.onclick = () => {
    km = b.dataset.km; localStorage.km = km;
    document.querySelectorAll("#kmChips button").forEach((x) => x.classList.toggle("on", x === b));
    load();
  };
});
$("#refresh").onclick = load;

// ---- tabs ----
function showTab(t) {
  $("#nearbyPane").classList.toggle("hidden", t !== "nearby");
  $("#tripPane").classList.toggle("hidden", t !== "trip");
  $("#tabNearby").classList.toggle("on", t === "nearby");
  $("#tabTrip").classList.toggle("on", t === "trip");
  if (t === "trip" && map) setTimeout(() => map.invalidateSize(), 50);
  if (t === "nearby") load();
}
$("#tabNearby").onclick = () => showTab("nearby");
$("#tabTrip").onclick = () => showTab("trip");

// ---- trip planner ----
let map = null, routeLine = null, markers = [];
let detour = localStorage.detour || "5";

function initMap() {
  if (map) return map;
  map = L.map("map").setView([-33.9, 151.2], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap",
  }).addTo(map);
  return map;
}

function priceColor(p, prices) {
  const lo = Math.min(...prices), hi = Math.max(...prices);
  if (p === lo) return "#2ecc71";
  if (p === hi) return "#e67e22";
  return "#3498db";
}

function pickCard(r, label, cls) {
  const eff = effPrice(r);
  const wool = isWoolies(r);
  const div = document.createElement("div");
  div.className = "card pick " + (cls || "");
  div.innerHTML =
    '<div class="info">' +
    '<div class="name"><span class="badge">' + label + '</span> ' + esc(r.brand || r.name || "?") +
    (wool ? '<span class="badge wool">Woolies &minus;4&cent;</span>' : "") + '</div>' +
    '<div class="addr">' + esc(r.suburb || r.address || "") + ' &middot; ' + r.along_km + ' km into trip &middot; ' + r.detour_km + ' km off-route' +
    (wool ? ' <span class="dim">(pump ' + r.price.toFixed(1) + ')</span>' : "") + '</div>' +
    "</div>" +
    '<div class="price">' + eff.toFixed(1) + "<span style='font-size:12px;font-weight:400'> c/L</span></div>";
  div.addEventListener("click", () => window.open("https://www.google.com/maps/dir/?api=1&destination=" + r.lat + "," + r.lng, "_blank"));
  return div;
}

const TOP_N = 6;
let tripMode = localStorage.tripMode || "blend";
let tripResults = [];
let wooliesOn = localStorage.wooliesOff !== "0";

const WOOLIES_RE = /woolworths|woolies|caltex|metrogo/i;  // Woolies fuel discount sites
function isWoolies(r) { return wooliesOn && WOOLIES_RE.test((r.brand || "") + " " + (r.name || "")); }
function effPrice(r) { return r.price - (isWoolies(r) ? 4 : 0); }

function rankResults(mode) {
  const rs = tripResults;
  if (!rs.length) return [];
  const keyP = (r) => effPrice(r);
  if (mode === "price") return [...rs].sort((a, b) => keyP(a) - keyP(b) || a.detour_km - b.detour_km).slice(0, TOP_N);
  if (mode === "close") return [...rs].sort((a, b) => a.detour_km - b.detour_km || keyP(a) - keyP(b)).slice(0, TOP_N);
  // blend: 0-1 normalise eff price and detour, average the ranks
    const ps = rs.map(keyP), ds = rs.map(r => r.detour_km);
    const plo = Math.min(...ps), phi = Math.max(...ps), dlo = Math.min(...ds), dhi = Math.max(...ds);
    const n = (v, lo, hi) => (hi - lo < 1e-9 ? 0 : (v - lo) / (hi - lo));
    return [...rs].sort((a, b) =>
      (n(keyP(a), plo, phi) + n(a.detour_km, dlo, dhi)) - (n(keyP(b), plo, phi) + n(b.detour_km, dlo, dhi))
    ).slice(0, TOP_N);
}

const MODE_LABEL = { close: "closest + cheap", price: "best price", blend: "best blend" };

function renderTrip() {
  const tl = $("#tripList");
  tl.innerHTML = "";
  markers.forEach((m) => m.remove()); markers = [];
  const map_ = initMap();
  if (routeLine) routeLine.remove();
  if (window._tripPath && window._tripPath.length > 1) {
    routeLine = L.polyline(window._tripPath, { color: "#4da3ff", weight: 5, opacity: 0.7 }).addTo(map_);
    map_.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
  const all = tripResults;
  const picks = rankResults(tripMode);
  const pickIds = new Set(picks.map(r => r.id));
  for (const r of all) {
    const m = L.circleMarker([r.lat, r.lng], {
      radius: pickIds.has(r.id) ? 11 : 5,
      fillColor: pickIds.has(r.id) ? "#2ecc71" : "#3a4150",
      color: pickIds.has(r.id) ? "#ffe066" : "#666", weight: 1.5, fillOpacity: 0.9,
    }).addTo(map_);
    m.bindTooltip(`${r.brand || r.name} ${r.price}¢ · +${r.detour_km} km`);
    m.on("click", () => window.open("https://www.google.com/maps/dir/?api=1&destination=" + r.lat + "," + r.lng, "_blank"));
    markers.push(m);
  }
  for (const r of picks) tl.appendChild(pickCard(r, MODE_LABEL[tripMode]));
}

async function planTrip() {
  const to = $("#toInput").value.trim();
  if (!to) { $("#tripStatus").textContent = "where to?"; return; }
  $("#tripStatus").textContent = "planning route…";
  const q = new URLSearchParams({ to, fuel, detour });
  const f = $("#fromInput").value.trim();
  if (!f && coords) { q.set("flat", coords.lat); q.set("flng", coords.lng); }
  else q.set("from", f);
  try {
    const r = await fetch("/api/route?" + q);
    const d = await r.json();
    if (d.error) { $("#tripStatus").textContent = d.error; return; }
    window._tripPath = d.path || [];
    tripResults = d.results || [];
    $("#tripModes").style.display = tripResults.length ? "flex" : "none";
    $("#tripStatus").textContent = tripResults.length + " stations along " + d.route_km + " km (within " + detour + " km) — showing top " + TOP_N + ", " + MODE_LABEL[tripMode];
    renderTrip();
    if (!tripResults.length) $("#tripStatus").textContent += " — try a wider detour";
  } catch (e) {
    $("#tripStatus").textContent = "route failed, try again";
  }
}
$("#goTrip").onclick = planTrip;
$("#toInput").addEventListener("keydown", (e) => e.key === "Enter" && planTrip());
document.querySelectorAll("#tripModes button").forEach((b) => {
  if (b.dataset.mode === tripMode) b.classList.add("on");
  b.onclick = () => {
    tripMode = b.dataset.mode; localStorage.tripMode = tripMode;
    document.querySelectorAll("#tripModes button").forEach((x) => x.classList.toggle("on", x === b));
    if (tripResults.length) renderTrip();
  };
});

// trip fuel picker (mirror of the nearby chips; same `fuel` state)
const FUELS = [["U91", "91"], ["U95", "95"], ["U98", "98"], ["DL", "Diesel"], ["LPG", "LPG"]];
const tf = document.getElementById("tripFuel");
FUELS.forEach(([f, label]) => {
  const b = document.createElement("button");
  b.textContent = label; b.dataset.fuel = f;
  if (f === fuel) b.classList.add("on");
  b.onclick = () => {
    fuel = f; localStorage.fuel = fuel;
    syncFuelChips();
    if (tripResults.length) planTrip();
  };
  tf.appendChild(b);
});
function syncFuelChips() {
  document.querySelectorAll("#fuelChips button, #tripFuel button").forEach((x) => x.classList.toggle("on", x.dataset.fuel === fuel));
}
const wT = document.getElementById("wooliesToggle");
wT.checked = wooliesOn;
wT.onchange = () => {
  wooliesOn = wT.checked;
  localStorage.wooliesOff = wT.checked ? "1" : "0";
  if (tripResults.length) renderTrip();
};
document.querySelectorAll("#detourChips button[data-km]").forEach((b) => {
  if (b.dataset.km === String(detour)) b.classList.add("on");
  b.onclick = () => {
    detour = b.dataset.km; localStorage.detour = detour;
    document.querySelectorAll("#detourChips button[data-km]").forEach((x) => x.classList.toggle("on", x === b));
    if ($("#tripStatus").textContent.includes("km into")) planTrip();
  };
});

// one-time lat/lng override for testing: #lat,lng in URL
const h = location.hash.match(/(-?\d+\.\d+),(-?\d+\.\d+)/);
if (h) { coords = { lat: +h[1], lng: +h[2] }; load(); }
else if (localStorage.coords && !navigator.geolocation) { coords = JSON.parse(localStorage.coords); load(); }
else locate();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
