# Cheap Fuel AU

Personal live fuel-price web app (NSW, QLD, WA). Python stdlib only, no dependencies.

## Run locally

    PORT=8788 python3 server.py

Open http://localhost:8788. Add to phone home screen for app mode.

## Config

`config.json`:

    {"nsw_api_key": "...", "nsw_api_secret": "..."}

NSW keys free at api.nsw.gov.au (Fuel API). QLD/WA need no keys.

## Endpoints

- `GET /api/stations?lat&lng&fuel=U91|U95|U98|DL|LPG&km=5` nearest prices sorted cheapest first
- `GET /api/status`

## Render

Free tier web service, start command `python3 server.py`, env `PORT` provided by platform. `render.yaml` included for blueprint deploy. Free instances sleep; first load after idle can take ~30s.
