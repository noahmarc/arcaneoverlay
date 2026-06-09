#!/usr/bin/env python3
"""
ArcaneOverlay Multiplayer Server
Pure Python 3 stdlib — no external dependencies.
Serves static files (HTTP) and handles multiplayer via HTTP polling on the same port.
"""

import asyncio, json, os, random, string, time, mimetypes, urllib.request, urllib.parse, re
from pathlib import Path
import music

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
PLAYER_TIMEOUT = 30  # seconds

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

def http_response(writer, status, body_bytes, content_type='application/json', origin='*'):
    # Echo the caller's Origin back so both file:// (null) and http:// origins
    # pass the browser's CORS check.  '*' is the safe fallback for curl/no-origin.
    allow_origin = origin if origin else '*'
    cors = (
        f'Access-Control-Allow-Origin: {allow_origin}\r\n'
        'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n'
        'Access-Control-Allow-Headers: Content-Type\r\n'
    )
    headers = (
        f'HTTP/1.1 {status}\r\n'
        f'Content-Type: {content_type}\r\n'
        f'Content-Length: {len(body_bytes)}\r\n'
        f'{cors}'
        f'Connection: close\r\n'
        f'\r\n'
    )
    writer.write(headers.encode() + body_bytes)

def json_ok(writer, data, origin='*'):
    body = json.dumps(data).encode()
    http_response(writer, '200 OK', body, 'application/json', origin)

def json_err(writer, msg, status='400 Bad Request', origin='*'):
    body = json.dumps({'ok': False, 'error': msg}).encode()
    http_response(writer, status, body, 'application/json', origin)

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
    if is_dm:
        # DM has full authority — replace the whole state
        room['grid_state'] = state
    else:
        # Player push: merge only the fields players are allowed to mutate
        current = room.get('grid_state') or {}
        # Player-mutable fields (mirror the player-restricted UI: tokens
        # via TOKEN, plus labels if they ever get permission).
        for field in ('tokens', 'labels'):
            if field in state:
                current[field] = state[field]
        # If the room had no prior state, seed with what we have
        room['grid_state'] = current

    room['last_seen'][pid] = now_s()
    ev = {
        'type':  'grid_state',
        'state': room['grid_state'],
        'ts':    now_ms(),
    }
    add_event(room, ev)
    json_ok(writer, {'ok': True})

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
    ts = now_ms()
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
    json_ok(writer, {'ok': True})

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
MANIFEST_URL = 'https://raw.githubusercontent.com/noahmarc/arcaneoverlay/main/updates.json'

def _fetch_manifest_sync():
    """Blocking GitHub fetch — called via run_in_executor so it won't stall the loop."""
    req = urllib.request.Request(MANIFEST_URL, headers={'User-Agent': 'ArcaneOverlay/1.7'})
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode())
    return data

async def handle_check_update(writer, origin='*'):
    """Proxy the update manifest from GitHub so the WKWebView can read it
    without hitting Same-Origin-Policy restrictions on file:// pages."""
    try:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(None, _fetch_manifest_sync)
        json_ok(writer, data, origin)
    except Exception as e:
        json_err(writer, f'Manifest fetch failed: {e}', origin=origin)

# ── Projector sync ──────────────────────────────────────────────────────
# The DM's WKWebView POSTs its current grid state to /api/proj_state.
# A Safari window opened with ?projector=1 polls GET /api/proj_state
# every ~300ms and re-renders.  Single in-memory slot (no rooms / no
# auth) — this is local-loopback only and overhead is trivial.
_projector_state = {'ts': 0, 'state': None}

async def handle_proj_state_post(writer, body, origin='*'):
    try:
        _projector_state['state'] = body.get('state')
        _projector_state['ts']    = int(time.time() * 1000)
        json_ok(writer, {'ok': True, 'ts': _projector_state['ts']}, origin)
    except Exception as e:
        json_err(writer, f'proj_state post failed: {e}', origin=origin)

async def handle_proj_state_get(writer, origin='*'):
    try:
        json_ok(writer, {
            'ts': _projector_state['ts'],
            'state': _projector_state['state'],
        }, origin)
    except Exception as e:
        json_err(writer, f'proj_state get failed: {e}', origin=origin)

# ── Music library (local files) ──────────────────────────────────────────────
_music_diag = {}

async def handle_music_diag_post(writer, body, origin='*'):
    global _music_diag
    _music_diag = body or {}
    json_ok(writer, {'ok': True}, origin)

async def handle_music_diag_get(writer, origin='*'):
    json_ok(writer, _music_diag, origin)


_IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp')
def _qp(params, key, default=''):
    v = params.get(key, [default]); return (v[0] if isinstance(v, list) else v) or default
async def handle_fs_list(writer, params, origin='*'):
    p = _qp(params, 'path') or str(Path.home())
    kind = _qp(params, 'ext')                      # 'json' to browse backups, else images
    exts = ('.json',) if kind == 'json' else _IMG_EXT
    try:
        base = Path(p).expanduser()
        if not base.is_dir():
            base = Path.home()
        base = base.resolve()
        dirs, files = [], []
        for entry in sorted(base.iterdir(), key=lambda x: x.name.lower()):
            try:
                if entry.name.startswith('.'):
                    continue
                if entry.is_dir():
                    dirs.append(entry.name)
                elif entry.suffix.lower() in exts:
                    files.append(entry.name)
            except Exception:
                pass
        json_ok(writer, {'path': str(base), 'parent': str(base.parent), 'dirs': dirs, 'files': files}, origin)
    except Exception as e:
        json_err(writer, str(e), '500 Internal Server Error', origin)

async def handle_fs_file(writer, params, origin='*'):
    p = _qp(params, 'path')
    try:
        fp = Path(p).expanduser().resolve()
        if not fp.is_file() or fp.suffix.lower() not in _IMG_EXT:
            json_err(writer, 'not an image', '404 Not Found', origin); return
        data = fp.read_bytes()
        mime = mimetypes.guess_type(str(fp))[0] or 'application/octet-stream'
        http_response(writer, '200 OK', data, mime, origin)
    except Exception as e:
        json_err(writer, str(e), '500 Internal Server Error', origin)

async def handle_fs_readtext(writer, params, origin='*'):
    p = _qp(params, 'path')
    try:
        fp = Path(p).expanduser().resolve()
        if not fp.is_file() or fp.suffix.lower() != '.json':
            json_err(writer, 'not a json file', '404 Not Found', origin); return
        if fp.stat().st_size > 80 * 1024 * 1024:
            json_err(writer, 'file too large', '413 Payload Too Large', origin); return
        http_response(writer, '200 OK', fp.read_bytes(), 'text/plain; charset=utf-8', origin)
    except Exception as e:
        json_err(writer, str(e), '500 Internal Server Error', origin)

async def handle_save_file(writer, raw_body, params, origin='*'):
    name = re.sub(r'[^A-Za-z0-9._-]', '_', _qp(params, 'name', 'arcane-backup.json')) or 'arcane-backup.json'
    try:
        downloads = Path.home() / 'Downloads'; downloads.mkdir(exist_ok=True)
        dest = downloads / name; n = 1
        stem, dot, ext = name.rpartition('.')
        while dest.exists():
            dest = downloads / ((stem or name) + f' ({n})' + (dot + ext if dot else '')); n += 1
        dest.write_bytes(raw_body)
        json_ok(writer, {'ok': True, 'path': str(dest)}, origin)
    except Exception as e:
        json_err(writer, 'save failed: ' + str(e), '500 Internal Server Error', origin)

_jslog = []
async def handle_jslog_post(writer, body, origin='*'):
    try:
        _jslog.append(body or {})
        del _jslog[:-50]
    except Exception:
        pass
    json_ok(writer, {'ok': True}, origin)

async def handle_jslog_get(writer, origin='*'):
    json_ok(writer, {'errors': _jslog}, origin)


# ── Online sound-effect browser (myinstants.com proxy) ──────────────────────
# The page can't fetch myinstants directly (no CORS), so we scrape/stream it
# server-side.  Only myinstants.com is ever contacted, and only its
# /media/sounds/*.mp3 assets are proxied — no arbitrary host fetching.
_MI_BASE = 'https://www.myinstants.com'
_MI_UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ArcaneOverlay/1.7'}
_MI_INSTANT = re.compile(
    r"play\('(/media/sounds/[^']+\.mp3)'.*?instant-link[^>]*>([^<]+)</a>", re.S)

def _mi_fetch_page(url):
    req = urllib.request.Request(url, headers=_MI_UA)
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read().decode('utf-8', errors='replace')

def _mi_parse(html):
    out, seen = [], set()
    for m in _MI_INSTANT.finditer(html):
        path = m.group(1)
        name = re.sub(r'\s+', ' ', m.group(2)).strip()
        if path in seen:
            continue
        seen.add(path)
        out.append({'name': name or path.rsplit('/', 1)[-1], 'url': path})
    return out

async def handle_sounds_search(writer, params, origin='*'):
    q = (params.get('q', [''])[0] if isinstance(params.get('q'), list) else params.get('q', '')).strip()
    try:
        page = int((params.get('page', ['1'])[0] if isinstance(params.get('page'), list) else params.get('page', '1')) or '1')
    except Exception:
        page = 1
    page = max(1, page)
    try:
        if q:
            url = _MI_BASE + '/en/search/?name=' + urllib.parse.quote(q) + '&page=' + str(page)
        else:
            # default: trending "Sound effects" category for the US, per request
            url = _MI_BASE + '/en/categories/sound%20effects/us/?page=' + str(page)
        html = await asyncio.get_event_loop().run_in_executor(None, _mi_fetch_page, url)
        results = _mi_parse(html)
        json_ok(writer, {'results': results, 'page': page, 'more': len(results) >= 30}, origin)
    except Exception as e:
        json_err(writer, 'fetch failed: ' + str(e), '502 Bad Gateway', origin)

async def handle_save_recording(writer, raw_body, params, origin='*'):
    name = params.get('name', ['arcane-mix'])
    name = (name[0] if isinstance(name, list) else name) or 'arcane-mix'
    name = re.sub(r'[^A-Za-z0-9._-]', '_', name)
    if not name.lower().endswith('.wav'):
        name += '.wav'
    try:
        downloads = Path.home() / 'Downloads'
        downloads.mkdir(exist_ok=True)
        dest = downloads / name
        n = 1
        while dest.exists():
            dest = downloads / (name[:-4] + f' ({n}).wav'); n += 1
        dest.write_bytes(raw_body)
        json_ok(writer, {'ok': True, 'path': str(dest)}, origin)
    except Exception as e:
        json_err(writer, 'save failed: ' + str(e), '500 Internal Server Error', origin)

async def handle_sounds_fetch(writer, params, origin='*'):
    raw = params.get('url', [''])[0] if isinstance(params.get('url'), list) else params.get('url', '')
    raw = urllib.parse.unquote(raw or '')
    # Accept only myinstants media paths — block SSRF to any other host.
    if raw.startswith(_MI_BASE):
        raw = raw[len(_MI_BASE):]
    if not raw.startswith('/media/sounds/') or '..' in raw:
        json_err(writer, 'bad url', '400 Bad Request', origin)
        return
    try:
        url = _MI_BASE + raw
        def _get():
            req = urllib.request.Request(url, headers=_MI_UA)
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read()
        data = await asyncio.get_event_loop().run_in_executor(None, _get)
        http_response(writer, '200 OK', data, 'audio/mpeg', origin)
    except Exception as e:
        json_err(writer, 'fetch failed: ' + str(e), '502 Bad Gateway', origin)


def _pub_track(t):
    return {k: v for k, v in t.items() if k != 'path'}

def _pub_cache(cache):
    return {
        'folder': cache.get('folder', ''),
        'tracks': [_pub_track(t) for t in cache.get('tracks', [])],
        'analysis': cache.get('analysis', {}),
        'playlists': cache.get('playlists', []),
        'bindings': cache.get('bindings', {}),
    }

async def handle_music_scan(writer, body, origin='*'):
    folder = (body or {}).get('folder') or str(Path.home() / 'Music')
    cache = music.scan_folder(folder)
    if cache is None:
        json_err(writer, f'Not a folder: {folder}', status='404 Not Found', origin=origin)
        return
    json_ok(writer, _pub_cache(cache), origin)

async def handle_music_library(writer, origin='*'):
    json_ok(writer, _pub_cache(music.load_cache()), origin)

async def handle_music_analysis(writer, body, origin='*'):
    items = (body or {}).get('items') or []
    music.save_analysis(items)
    json_ok(writer, {'saved': len(items)}, origin)

async def handle_music_playlists(writer, body, origin='*'):
    music.save_playlists((body or {}).get('playlists') or [])
    json_ok(writer, {'ok': True}, origin)

async def handle_music_bindings(writer, body, origin='*'):
    music.save_bindings((body or {}).get('bindings') or {})
    json_ok(writer, {'ok': True}, origin)

async def handle_music_file(writer, params, headers, origin='*'):
    """Serve an audio file from the scanned library with HTTP Range support."""
    vals = params.get('id', [''])
    tid = vals[0] if isinstance(vals, list) else vals
    path = music.path_for_id(tid)
    if not path:
        http_response(writer, '404 Not Found', b'Not Found', 'text/plain', origin)
        return
    try:
        size = os.path.getsize(path)
        ctype = music.content_type_for(path)
        start, end, status = 0, size - 1, '200 OK'
        rng = headers.get('range', '')
        if rng.startswith('bytes='):
            s, _, e = rng[6:].partition('-')
            try:
                if s.strip() == '' and e.strip() != '':       # suffix: last N bytes
                    start, end = max(0, size - int(e)), size - 1
                else:
                    start = int(s) if s.strip() else 0
                    end = int(e) if e.strip() else size - 1
                start = max(0, start); end = min(end, size - 1)
                if start <= end:
                    status = '206 Partial Content'
                else:
                    start, end = 0, size - 1
            except Exception:
                start, end, status = 0, size - 1, '200 OK'
        length = end - start + 1
        with open(path, 'rb') as f:
            f.seek(start)
            data = f.read(length)
        hdrs = (
            f'HTTP/1.1 {status}\r\n'
            f'Content-Type: {ctype}\r\n'
            f'Content-Length: {length}\r\n'
            f'Accept-Ranges: bytes\r\n'
        )
        if status.startswith('206'):
            hdrs += f'Content-Range: bytes {start}-{end}/{size}\r\n'
        hdrs += (
            f'Access-Control-Allow-Origin: {origin}\r\n'
            f'Cache-Control: no-cache\r\n'
            f'Connection: close\r\n\r\n'
        )
        writer.write(hdrs.encode() + data)
        await writer.drain()
        writer.close()
    except Exception as e:
        http_response(writer, '500 Internal Server Error', str(e).encode(), 'text/plain', origin)

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

        # Extract Origin so we can echo it back in all responses
        origin = headers.get('origin', '*') or '*'

        # Handle OPTIONS preflight
        if method == 'OPTIONS':
            allow_origin = origin
            resp = (
                'HTTP/1.1 200 OK\r\n'
                f'Access-Control-Allow-Origin: {allow_origin}\r\n'
                'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n'
                'Access-Control-Allow-Headers: Content-Type\r\n'
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
        raw_body = b''
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
            elif method == 'GET' and endpoint == 'my_ip':
                await handle_my_ip(writer)
            elif method == 'GET' and endpoint == 'find_room':
                params = parse_qs(qs)
                await handle_find_room(writer, params)
            elif method == 'GET' and endpoint == 'check_update':
                await handle_check_update(writer, origin)
            elif method == 'POST' and endpoint == 'proj_state':
                await handle_proj_state_post(writer, body, origin)
            elif method == 'GET' and endpoint == 'proj_state':
                await handle_proj_state_get(writer, origin)
            elif method == 'POST' and endpoint == 'music/scan':
                await handle_music_scan(writer, body, origin)
            elif method == 'GET' and endpoint == 'music/library':
                await handle_music_library(writer, origin)
            elif method == 'POST' and endpoint == 'music/analysis':
                await handle_music_analysis(writer, body, origin)
            elif method == 'POST' and endpoint == 'music/playlists':
                await handle_music_playlists(writer, body, origin)
            elif method == 'POST' and endpoint == 'music/bindings':
                await handle_music_bindings(writer, body, origin)
            elif method == 'GET' and endpoint == 'music/file':
                params = parse_qs(qs)
                await handle_music_file(writer, params, headers, origin)
            elif method == 'POST' and endpoint == 'music/diag':
                await handle_music_diag_post(writer, body, origin)
            elif method == 'GET' and endpoint == 'music/diag':
                await handle_music_diag_get(writer, origin)
            elif method == 'GET' and endpoint == 'fs/list':
                await handle_fs_list(writer, parse_qs(qs), origin)
            elif method == 'GET' and endpoint == 'fs/file':
                await handle_fs_file(writer, parse_qs(qs), origin)
            elif method == 'GET' and endpoint == 'fs/readtext':
                await handle_fs_readtext(writer, parse_qs(qs), origin)
            elif method == 'POST' and endpoint == 'save_file':
                await handle_save_file(writer, raw_body, parse_qs(qs), origin)
            elif method == 'POST' and endpoint == 'jslog':
                await handle_jslog_post(writer, body, origin)
            elif method == 'GET' and endpoint == 'jslog':
                await handle_jslog_get(writer, origin)
            elif method == 'GET' and endpoint == 'sounds/search':
                await handle_sounds_search(writer, parse_qs(qs), origin)
            elif method == 'GET' and endpoint == 'sounds/fetch':
                await handle_sounds_fetch(writer, parse_qs(qs), origin)
            elif method == 'POST' and endpoint == 'save_recording':
                await handle_save_recording(writer, raw_body, parse_qs(qs), origin)
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
