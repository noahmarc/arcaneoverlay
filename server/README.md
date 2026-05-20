# ArcaneOverlay multiplayer server

Deployed to Render via `render.yaml`. Pure Python 3 stdlib, no dependencies.

Endpoints:
- `POST /api/create_room`, `/api/join_room`, `/api/leave`, `/api/send_message`,
  `/api/heartbeat`, `/api/grid_state`
- `GET  /api/poll`, `/api/find_room`, `/api/my_ip`

Returns CORS `Access-Control-Allow-Origin: *` on every response, so any
browser client (e.g. the hosted GitHub Pages bundle) can call it.
