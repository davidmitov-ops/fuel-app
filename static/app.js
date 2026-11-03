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

// one-time lat/lng override for testing: #lat,lng in URL
const h = location.hash.match(/(-?\d+\.\d+),(-?\d+\.\d+)/);
if (h) { coords = { lat: +h[1], lng: +h[2] }; load(); }
else if (localStorage.coords && !navigator.geolocation) { coords = JSON.parse(localStorage.coords); load(); }
else locate();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
