#!/usr/bin/env python3
"""
ArcaneOverlay Multiplayer Server
Pure Python 3 stdlib — no external dependencies.
Serves static files (HTTP) and handles multiplayer via HTTP polling on the same port.
"""

import asyncio, json, os, random, string, time, mimetypes
from pathlib import Path

# ── In-memory state ────────────────────────────────────────────────────────────
# rooms[code] = {
#   dm_id:      str,
#   players:    {id -> name},
#   events:     [{type, ts, ...}],
#   last_seen:  {id -> float}   (unix seconds)
# }
rooms = {}

STATIC_DIR = Path(__file__).parent
MAX_EVENTS = 200
PLAYER_TIMEOUT = 90  # seconds — generous enough to survive backgrounded-tab timer throttling and brief sleeps

# ── Helpers ────────────────────────────────────────────────────────────────────
def gen_code(n=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=n))

def gen_id(n=16):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))

def now_ms():
    return int(time.time() * 1000)

def now_s():
    return time.time()

def add_event(room, event):
    # Strictly-increasing timestamps: two events landing in the same
    # millisecond would otherwise straddle the client's `ts > since` poll
    # filter and one of them would be lost forever.
    if room['events'] and event['ts'] <= room['events'][-1]['ts']:
        event['ts'] = room['events'][-1]['ts'] + 1
    # grid_state snapshots supersede each other (and can embed a multi-MB
    # map image) — keep only the newest one in the buffer so late pollers
    # and new joiners don't replay a parade of stale heavyweight states.
    if event.get('type') == 'grid_state':
        room['events'] = [e for e in room['events'] if e.get('type') != 'grid_state']
    room['events'].append(event)
    if len(room['events']) > MAX_EVENTS:
        room['events'] = room['events'][-MAX_EVENTS:]

def purge_stale(room, code):
    """Remove players not seen in PLAYER_TIMEOUT seconds. Returns list of (id, name) removed."""
    cutoff = now_s() - PLAYER_TIMEOUT
    removed = []
    for pid, last in list(room['last_seen'].items()):
        if last < cutoff and pid in room['players']:
            name = room['players'].pop(pid, 'Unknown')
            room['last_seen'].pop(pid, None)
            removed.append((pid, name))
    for pid, name in removed:
        ev = {
            'type': 'player_left',
            'id': pid,
            'name': name,
            'players': dict(room['players']),
            'ts': now_ms(),
        }
        add_event(room, ev)
    # Clean up empty rooms (unless DM is still present)
    if not room['players']:
        rooms.pop(code, None)
    return removed

# ── CORS headers ───────────────────────────────────────────────────────────────
CORS_HEADERS = (
    'Access-Control-Allow-Origin: *\r\n'
    'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n'
    'Access-Control-Allow-Headers: Content-Type\r\n'
)

def http_response(writer, status, body_bytes, content_type='application/json'):
    headers = (
        f'HTTP/1.1 {status}\r\n'
        f'Content-Type: {content_type}\r\n'
        f'Content-Length: {len(body_bytes)}\r\n'
        f'{CORS_HEADERS}'
        f'Connection: close\r\n'
        f'\r\n'
    )
    writer.write(headers.encode() + body_bytes)

def json_ok(writer, data):
    body = json.dumps(data).encode()
    http_response(writer, '200 OK', body, 'application/json')

def json_err(writer, msg, status='400 Bad Request'):
    body = json.dumps({'ok': False, 'error': msg}).encode()
    http_response(writer, status, body, 'application/json')

# ── API handlers ───────────────────────────────────────────────────────────────
async def handle_create_room(writer, body):
    name      = (body.get('name')      or 'Dungeon Master').strip()[:32] or 'Dungeon Master'
    room_name = (body.get('room_name') or 'Adventure').strip()[:48]      or 'Adventure'
    code = gen_code()
    while code in rooms:
        code = gen_code()
    pid = gen_id()
    room = {
        'dm_id':     pid,
        'room_name': room_name,
        'players':   {pid: name},
        'events':    [],
        'last_seen': {pid: now_s()},
        'grid_state': None,   # Last full grid snapshot from the DM
    }
    rooms[code] = room
    json_ok(writer, {
        'ok':        True,
        'room':      code,
        'room_name': room_name,
        'player_id': pid,
        'name':      name,
        'dm_id':     pid,
        'players':   {pid: name},
    })

async def handle_join_room(writer, body):
    code = (body.get('room') or '').strip().upper()
    name = (body.get('name') or 'Adventurer').strip()[:32] or 'Adventurer'
    room = rooms.get(code)
    if not room:
        json_err(writer, 'Room not found')
        return
    # Deduplicate names
    taken = list(room['players'].values())
    base, n = name, 2
    while name in taken:
        name = f'{base}{n}'; n += 1
    pid = gen_id()
    room['players'][pid] = name
    room['last_seen'][pid] = now_s()
    ev = {
        'type': 'player_joined',
        'id': pid,
        'name': name,
        'players': dict(room['players']),
        'ts': now_ms(),
    }
    add_event(room, ev)
    json_ok(writer, {
        'ok':        True,
        'room':      code,
        'room_name': room.get('room_name', 'Adventure'),
        'player_id': pid,
        'name':      name,
        'dm_id':     room['dm_id'],
        'players':   dict(room['players']),
        'grid_state': room.get('grid_state'),   # latest DM snapshot (may be None)
    })

# ── Grid state sync (DM → server → players) ──────────────────────────────────
async def handle_grid_state(writer, body):
    """Sync grid snapshot.
       • DM push  → full replace.
       • Player push → only `tokens` (and `labels`) fields are merged into
         the existing snapshot, so players can move/place tokens without
         overwriting the DM's effects, walls, fog, etc.
    """
    code = (body.get('room') or '').strip().upper()
    pid  = (body.get('player_id') or '').strip()
    state = body.get('state')
    room = rooms.get(code)
    if not room:
        json_err(writer, 'Room not found'); return
    if pid not in room['players']:
        json_err(writer, 'You are not in this room', '403 Forbidden'); return
    if not isinstance(state, dict):
        json_err(writer, 'Bad grid state payload'); return

    is_dm = (pid == room['dm_id'])
    prev = room.get('grid_state') or {}
    pushed_new_bg = bool(state.get('bgImageDataUrl')) and not state.get('bgKeep')
    if is_dm:
        # DM has full authority — replace the whole state.
        # `bgKeep` means the client skipped re-sending the (multi-MB) map
        # image because it hasn't changed — carry the stored copy forward.
        if state.get('bgKeep') and not state.get('bgImageDataUrl'):
            state = dict(state)
            state.pop('bgKeep', None)
            if prev.get('bgImageDataUrl'):
                state['bgImageDataUrl'] = prev['bgImageDataUrl']
        room['grid_state'] = state
    else:
        # Player push: merge only the fields players are allowed to mutate
        current = prev
        # Player-mutable fields (mirror the player-restricted UI: tokens
        # via TOKEN, plus labels if they ever get permission).
        for field in ('tokens', 'labels'):
            if field in state:
                current[field] = state[field]
        # If the room had no prior state, seed with what we have
        room['grid_state'] = current

    room['last_seen'][pid] = now_s()
    # Broadcast a LIGHT event: receivers that already hold the map keep it
    # (bgKeep); the full image only travels in the event when it changes.
    # New joiners always get the full stored state from join_room or the
    # GET /api/grid_state recovery endpoint.
    full = room['grid_state'] or {}
    wire = full
    if full.get('bgImageDataUrl') and not (is_dm and pushed_new_bg):
        wire = dict(full)
        wire.pop('bgImageDataUrl', None)
        wire['bgKeep'] = 1
    ev = {
        'type':  'grid_state',
        'state': wire,
        'ts':    now_ms(),
    }
    add_event(room, ev)
    json_ok(writer, {'ok': True})

async def handle_grid_state_get(writer, params):
    """Return the full stored snapshot (incl. the map image). Used by clients
    that received a bgKeep event without ever having the original image."""
    code = params.get('room', [''])[0].strip().upper()
    room = rooms.get(code)
    if not room:
        json_ok(writer, {'ok': False})
        return
    json_ok(writer, {'ok': True, 'state': room.get('grid_state')})

async def handle_send_message(writer, body):
    code = (body.get('room') or '').strip().upper()
    pid = (body.get('player_id') or '').strip()
    to = (body.get('to') or 'all').strip()
    # 16 KB cap — generous enough for embedded JSON payloads like
    # __ROLLREQ__:{…}, __GIVEITEM__:{…} that exceed the prior 512-char cap.
    text = (body.get('text') or '').strip()[:16384]
    room = rooms.get(code)
    if not room:
        json_err(writer, 'Room not found')
        return
    if pid not in room['players']:
        json_err(writer, 'Player not in room')
        return
    if not text:
        json_err(writer, 'Empty message')
        return
    room['last_seen'][pid] = now_s()
    ev = {
        'type': 'chat',
        'from_id': pid,
        'from_name': room['players'][pid],
        'is_dm': pid == room['dm_id'],
        'text': text,
        'to': to,
        'ts': now_ms(),
    }
    add_event(room, ev)
    json_ok(writer, {'ok': True})

async def handle_find_room(writer, params):
    """Used by players for auto-discovery: does this server have a room with this code?"""
    code = params.get('code', [''])[0].strip().upper()
    room = rooms.get(code)
    if room:
        json_ok(writer, {'ok': True, 'room': code, 'players': dict(room['players']), 'dm_id': room['dm_id']})
    else:
        json_ok(writer, {'ok': False})

async def handle_poll(writer, params):
    code = params.get('room', [''])[0].strip().upper()
    pid = params.get('player_id', [''])[0].strip()
    try:
        since = int(params.get('since', ['0'])[0])
    except (ValueError, IndexError):
        since = 0

    room = rooms.get(code)
    if not room:
        json_ok(writer, {'events': [], 'ts': now_ms()})
        return

    if pid in room['players']:
        room['last_seen'][pid] = now_s()

    # Purge stale players
    purge_stale(room, code)

    events = [e for e in room['events'] if e['ts'] > since]
    # Advance the client's cursor only as far as the events we actually
    # delivered — returning now_ms() would skip any event that lands in the
    # same millisecond after this response is built.
    ts = events[-1]['ts'] if events else since
    json_ok(writer, {'events': events, 'ts': ts})

async def handle_heartbeat(writer, body):
    code = (body.get('room') or '').strip().upper()
    pid = (body.get('player_id') or '').strip()
    room = rooms.get(code)
    if not room:
        json_err(writer, 'Room not found')
        return
    if pid in room['players']:
        room['last_seen'][pid] = now_s()
    purge_stale(room, code)
    # in_room lets a purged client (slept laptop, throttled tab) detect it
    # and rejoin instead of silently 403-ing on every push afterwards.
    json_ok(writer, {'ok': True, 'in_room': pid in room['players']})

async def handle_my_ip(writer):
    """Return the server's local IP address so players know where to connect."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = '127.0.0.1'
    port = int(os.environ.get('PORT', 8765))
    json_ok(writer, {'ip': ip, 'port': port, 'url': f'http://{ip}:{port}'})

async def handle_leave(writer, body):
    code = (body.get('room') or '').strip().upper()
    pid = (body.get('player_id') or '').strip()
    room = rooms.get(code)
    if room and pid in room['players']:
        name = room['players'].pop(pid, 'Unknown')
        room['last_seen'].pop(pid, None)
        ev = {
            'type': 'player_left',
            'id': pid,
            'name': name,
            'players': dict(room['players']),
            'ts': now_ms(),
        }
        add_event(room, ev)
        if not room['players']:
            rooms.pop(code, None)
    json_ok(writer, {'ok': True})

# ── Query string parser ────────────────────────────────────────────────────────
def parse_qs(qs):
    """Parse a query string into a dict of key -> [value, ...]."""
    result = {}
    if not qs:
        return result
    for part in qs.split('&'):
        if '=' in part:
            k, _, v = part.partition('=')
            result.setdefault(k, []).append(_url_decode(v))
        elif part:
            result.setdefault(part, []).append('')
    return result

def _url_decode(s):
    # Simple percent-decoding for query values
    result = []
    i = 0
    s = s.replace('+', ' ')
    while i < len(s):
        if s[i] == '%' and i + 2 < len(s):
            try:
                result.append(chr(int(s[i+1:i+3], 16)))
                i += 3
                continue
            except ValueError:
                pass
        result.append(s[i])
        i += 1
    return ''.join(result)

# ── Main connection handler ────────────────────────────────────────────────────
async def handle_connection(reader, writer):
    try:
        req_line = (await reader.readline()).decode(errors='replace').strip()
        if not req_line:
            writer.close()
            return
        parts = req_line.split(' ')
        if len(parts) < 2:
            writer.close()
            return
        method = parts[0].upper()
        raw_path = parts[1]

        # Split path and query string
        if '?' in raw_path:
            path, _, qs = raw_path.partition('?')
        else:
            path, qs = raw_path, ''

        # Read headers
        headers = {}
        while True:
            line = (await reader.readline()).decode(errors='replace')
            if line in ('\r\n', '\n', ''):
                break
            if ':' in line:
                k, _, v = line.partition(':')
                headers[k.strip().lower()] = v.strip()

        # Handle OPTIONS preflight
        if method == 'OPTIONS':
            resp = (
                'HTTP/1.1 200 OK\r\n'
                f'{CORS_HEADERS}'
                'Content-Length: 0\r\n'
                'Connection: close\r\n'
                '\r\n'
            )
            writer.write(resp.encode())
            await writer.drain()
            writer.close()
            return

        # Read body for POST requests
        body = {}
        if method == 'POST':
            content_length = int(headers.get('content-length', 0))
            if content_length > 0:
                raw_body = await reader.readexactly(content_length)
                try:
                    body = json.loads(raw_body.decode(errors='replace'))
                except Exception:
                    body = {}

        # ── API routes ─────────────────────────────────────────────────
        if path.startswith('/api/'):
            endpoint = path[5:]  # strip '/api/'

            if method == 'POST' and endpoint == 'create_room':
                await handle_create_room(writer, body)
            elif method == 'POST' and endpoint == 'join_room':
                await handle_join_room(writer, body)
            elif method == 'POST' and endpoint == 'send_message':
                await handle_send_message(writer, body)
            elif method == 'GET' and endpoint == 'poll':
                params = parse_qs(qs)
                await handle_poll(writer, params)
            elif method == 'POST' and endpoint == 'heartbeat':
                await handle_heartbeat(writer, body)
            elif method == 'POST' and endpoint == 'leave':
                await handle_leave(writer, body)
            elif method == 'POST' and endpoint == 'grid_state':
                await handle_grid_state(writer, body)
            elif method == 'GET' and endpoint == 'grid_state':
                params = parse_qs(qs)
                await handle_grid_state_get(writer, params)
            elif method == 'GET' and endpoint == 'my_ip':
                await handle_my_ip(writer)
            elif method == 'GET' and endpoint == 'find_room':
                params = parse_qs(qs)
                await handle_find_room(writer, params)
            else:
                body_bytes = b'Not Found'
                http_response(writer, '404 Not Found', body_bytes, 'text/plain')

            await writer.drain()
            writer.close()
            return

        # ── Static file serving ────────────────────────────────────────
        if method != 'GET':
            writer.write(b'HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
            await writer.drain()
            writer.close()
            return

        if path in ('/', ''):
            path = '/index.html'

        file_path = STATIC_DIR / path.lstrip('/')
        # Prevent directory traversal
        try:
            file_path.resolve().relative_to(STATIC_DIR.resolve())
        except ValueError:
            writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            await writer.drain()
            writer.close()
            return

        try:
            data = file_path.read_bytes()
        except FileNotFoundError:
            writer.write(b'HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found')
            await writer.drain()
            writer.close()
            return
        except Exception:
            writer.write(b'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 5\r\n\r\nError')
            await writer.drain()
            writer.close()
            return

        mime = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
        hdrs = (
            f'HTTP/1.1 200 OK\r\n'
            f'Content-Type: {mime}\r\n'
            f'Content-Length: {len(data)}\r\n'
            f'{CORS_HEADERS}'
            f'Cache-Control: no-cache\r\n'
            f'Connection: close\r\n'
            f'\r\n'
        )
        writer.write(hdrs.encode() + data)
        await writer.drain()
        writer.close()

    except Exception:
        try:
            writer.close()
        except Exception:
            pass

# ── Entry point ────────────────────────────────────────────────────────────────
async def main():
    port = int(os.environ.get('PORT', 8765))
    server = await asyncio.start_server(handle_connection, '0.0.0.0', port)
    print(f'ArcaneOverlay server running on port {port}')
    print(f'Serving files from: {STATIC_DIR}')
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    asyncio.run(main())
