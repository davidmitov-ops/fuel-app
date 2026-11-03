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
    document.querySelectorAll("#fuelChips button").forEach((x) => x.classList.toggle("on", x === b));
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
  const div = document.createElement("div");
  div.className = "card pick " + (cls || "");
  div.innerHTML =
    '<div class="info">' +
    '<div class="name"><span class="badge">' + label + '</span> ' + esc(r.brand || r.name || "?") + '</div>' +
    '<div class="addr">' + esc(r.suburb || r.address || "") + ' &middot; ' + r.along_km + ' km into trip &middot; ' + r.detour_km + ' km off-route</div>' +
    "</div>" +
    '<div class="price">' + r.price.toFixed(1) + "<span style='font-size:12px;font-weight:400'> c/L</span></div>";
  div.addEventListener("click", () => window.open("https://www.google.com/maps/dir/?api=1&destination=" + r.lat + "," + r.lng, "_blank"));
  return div;
}

function renderTrip(res, picks) {
  const tl = $("#tripList");
  tl.innerHTML = "";
  markers.forEach((m) => m.remove()); markers = [];
  const map_ = initMap();
  if (routeLine) routeLine.remove();
  if (window._tripPath && window._tripPath.length > 1) {
    routeLine = L.polyline(window._tripPath, { color: "#4da3ff", weight: 5, opacity: 0.7 }).addTo(map_);
    map_.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
  const prices = res.map(r => r.price);
  const pickIds = new Set();
  if (picks) {
    const seen = new Set();
    const best = (picks.best || []).filter(r => !seen.has(r.id) && seen.add(r.id));
    const smart = (picks.smart || []).filter(r => !best.includes(r) && !seen.has(r.id) && seen.add(r.id));
    for (const r of best) { tl.appendChild(pickCard(r, "best price")); pickIds.add(r.id); }
    for (const r of smart) { tl.appendChild(pickCard(r, "smart stop", "smart")); pickIds.add(r.id); }
  }
  for (const r of res) {
    const m = L.circleMarker([r.lat, r.lng], {
      radius: pickIds.has(r.id) ? 11 : 8,
      fillColor: pickIds.has(r.id) ? "#2ecc71" : priceColor(r.price, prices),
      color: pickIds.has(r.id) ? "#ffe066" : "#fff", weight: 2, fillOpacity: 1,
    }).addTo(map_);
    m.bindTooltip(`${r.brand || r.name} ${r.price}¢ · +${r.detour_km} km`);
    m.on("click", () => window.open("https://www.google.com/maps/dir/?api=1&destination=" + r.lat + "," + r.lng, "_blank"));
    markers.push(m);
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML =
      '<div class="info">' +
      '<div class="name">' + esc(r.brand || r.name || "?") + '</div>' +
      '<div class="addr">' + esc(r.suburb || r.address || "") + ' &middot; ' + r.along_km + ' km into trip &middot; ' + r.detour_km + ' km off-route</div>' +
      "</div>" +
      '<div class="price">' + r.price.toFixed(1) + "<span style='font-size:12px;font-weight:400'> c/L</span></div>";
    div.addEventListener("click", () => window.open("https://www.google.com/maps/dir/?api=1&destination=" + r.lat + "," + r.lng, "_blank"));
    tl.appendChild(div);
  }
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
    $("#tripStatus").textContent = d.results.length + " stations along " + d.route_km + " km (within " + detour + " km)";
    renderTrip(d.results || [], d.picks);
    if (!d.results.length) $("#tripStatus").textContent += " — try a wider detour";
  } catch (e) {
    $("#tripStatus").textContent = "route failed, try again";
  }
}
$("#goTrip").onclick = planTrip;
$("#toInput").addEventListener("keydown", (e) => e.key === "Enter" && planTrip());
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
