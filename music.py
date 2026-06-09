#!/usr/bin/env python3
"""
ArcaneOverlay — local music library backend.

Pure Python 3 stdlib (no external deps), matching server.py's design.  Audio
DECODING and key/BPM ANALYSIS happen in the WebView via the Web Audio API —
this module only:
  • scans a folder for audio files and reads basic tags (MP4/MP3/FLAC),
  • serves audio bytes with HTTP Range support (for Web Audio fetch/seek),
  • persists a JSON cache of {tracks, analysis, playlists} so re-scans are
    instant and analysis (computed once in the browser) is remembered.

Security: the file endpoint only serves paths that are present in the scanned
library (looked up by id), so it can't be used to read arbitrary files.
"""

import os, json, hashlib, struct
from pathlib import Path

AUDIO_EXTS = {'.mp3', '.m4a', '.aac', '.mp4', '.flac', '.wav', '.aiff', '.aif', '.ogg', '.oga', '.opus'}

# ── Cache location ───────────────────────────────────────────────────────────
def _support_dir():
    d = Path.home() / 'Library' / 'Application Support' / 'ArcaneOverlay'
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return d

CACHE_PATH = _support_dir() / 'music.json'

_DEFAULT = {'folder': '', 'tracks': [], 'analysis': {}, 'playlists': [], 'bindings': {}}

def load_cache():
    try:
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for k, v in _DEFAULT.items():
            data.setdefault(k, v if not isinstance(v, (list, dict)) else type(v)())
        return data
    except Exception:
        return json.loads(json.dumps(_DEFAULT))

def save_cache(data):
    try:
        tmp = CACHE_PATH.with_suffix('.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, CACHE_PATH)
        return True
    except Exception:
        return False

def track_id(path):
    return hashlib.sha1(os.path.abspath(path).encode('utf-8', 'replace')).hexdigest()[:16]

# ── Tag parsing (minimal, best-effort) ───────────────────────────────────────
def _read(f, n):
    b = f.read(n)
    return b if len(b) == n else b''

def _tags_mp4(path):
    """Parse ©nam/©ART/©alb from an MP4/M4A ilst atom."""
    out = {}
    KEYMAP = {b'\xa9nam': 'title', b'\xa9ART': 'artist', b'\xa9alb': 'album'}
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            def walk(start, end, depth=0):
                f.seek(start)
                pos = start
                while pos < end and depth < 8:
                    hdr = _read(f, 8)
                    if len(hdr) < 8:
                        break
                    asz = struct.unpack('>I', hdr[:4])[0]
                    atype = hdr[4:8]
                    body = pos + 8
                    if asz == 1:                       # 64-bit extended size
                        ext = _read(f, 8)
                        asz = struct.unpack('>Q', ext)[0]
                        body = pos + 16
                    elif asz == 0:                     # extends to end
                        asz = end - pos
                    aend = pos + asz
                    if aend <= pos or aend > end:
                        break
                    if atype in (b'moov', b'udta', b'trak', b'mdia', b'minf', b'stbl'):
                        walk(body, aend, depth + 1)
                    elif atype == b'meta':             # full atom: 4 version/flag bytes
                        walk(body + 4, aend, depth + 1)
                    elif atype == b'ilst':
                        _parse_ilst(f, body, aend, KEYMAP, out)
                    f.seek(aend)
                    pos = aend
            walk(0, size, 0)
    except Exception:
        pass
    return out

def _parse_ilst(f, start, end, keymap, out):
    f.seek(start); pos = start
    while pos < end:
        hdr = _read(f, 8)
        if len(hdr) < 8:
            break
        isz = struct.unpack('>I', hdr[:4])[0]
        itype = hdr[4:8]
        iend = pos + isz
        if isz < 8 or iend > end:
            break
        if itype in keymap:
            # child 'data' atom: size(4) 'data'(4) type(4) locale(4) value...
            dhdr = _read(f, 16)
            if len(dhdr) == 16 and dhdr[4:8] == b'data':
                dsz = struct.unpack('>I', dhdr[:4])[0]
                val = _read(f, max(0, dsz - 16))
                try:
                    out[keymap[itype]] = val.decode('utf-8', 'replace').strip('\x00').strip()
                except Exception:
                    pass
        f.seek(iend); pos = iend

def _decode_text_frame(data):
    if not data:
        return ''
    enc = data[0]; raw = data[1:]
    try:
        if enc == 0:   return raw.decode('latin-1', 'replace').strip('\x00').strip()
        if enc == 1:   return raw.decode('utf-16', 'replace').strip('\x00').strip()
        if enc == 2:   return raw.decode('utf-16-be', 'replace').strip('\x00').strip()
        return raw.decode('utf-8', 'replace').strip('\x00').strip()
    except Exception:
        return ''

def _synchsafe(b):
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]

def _tags_id3(path):
    """Parse TIT2/TPE1/TALB from an ID3v2 header on an MP3."""
    out = {}
    FRAMES = {b'TIT2': 'title', b'TPE1': 'artist', b'TALB': 'album'}
    try:
        with open(path, 'rb') as f:
            head = _read(f, 10)
            if head[:3] != b'ID3':
                return out
            ver = head[3]
            tag_size = _synchsafe(head[6:10])
            body = _read(f, tag_size)
        i = 0
        while i + 10 <= len(body):
            fid = body[i:i+4]
            if not fid or fid[0] == 0:
                break
            if ver >= 4:
                fsz = _synchsafe(body[i+4:i+8])
            else:
                fsz = struct.unpack('>I', body[i+4:i+8])[0]
            data = body[i+10:i+10+fsz]
            if fid in FRAMES:
                out[FRAMES[fid]] = _decode_text_frame(data)
            i += 10 + fsz
            if fsz <= 0:
                break
    except Exception:
        pass
    return out

def _tags_flac(path):
    out = {}
    WANT = {'TITLE': 'title', 'ARTIST': 'artist', 'ALBUM': 'album'}
    try:
        with open(path, 'rb') as f:
            if _read(f, 4) != b'fLaC':
                return out
            while True:
                bh = _read(f, 4)
                if len(bh) < 4:
                    break
                last = bh[0] & 0x80
                btype = bh[0] & 0x7f
                blen = (bh[1] << 16) | (bh[2] << 8) | bh[3]
                block = _read(f, blen)
                if btype == 4:   # VORBIS_COMMENT (little-endian lengths)
                    p = 0
                    vlen = struct.unpack('<I', block[p:p+4])[0]; p += 4 + vlen
                    cnt = struct.unpack('<I', block[p:p+4])[0]; p += 4
                    for _ in range(cnt):
                        clen = struct.unpack('<I', block[p:p+4])[0]; p += 4
                        c = block[p:p+clen].decode('utf-8', 'replace'); p += clen
                        if '=' in c:
                            k, _, v = c.partition('=')
                            if k.upper() in WANT:
                                out[WANT[k.upper()]] = v.strip()
                    break
                if last:
                    break
    except Exception:
        pass
    return out

def read_tags(path):
    ext = os.path.splitext(path)[1].lower()
    tags = {}
    try:
        if ext in ('.m4a', '.mp4', '.aac'):
            tags = _tags_mp4(path)
        elif ext == '.mp3':
            tags = _tags_id3(path)
        elif ext == '.flac':
            tags = _tags_flac(path)
    except Exception:
        tags = {}
    # Fallback: derive a title from the filename.
    if not tags.get('title'):
        tags['title'] = os.path.splitext(os.path.basename(path))[0]
    tags.setdefault('artist', '')
    tags.setdefault('album', '')
    return tags

# ── Scanning ─────────────────────────────────────────────────────────────────
def scan_folder(folder):
    """Walk `folder`, return list of track dicts.  Merges with cache so existing
    analysis is preserved by id."""
    folder = os.path.expanduser(folder or '')
    if not folder or not os.path.isdir(folder):
        return None
    cache = load_cache()
    existing_ids = {t['id'] for t in cache.get('tracks', [])}
    tracks = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for name in files:
            if os.path.splitext(name)[1].lower() not in AUDIO_EXTS:
                continue
            full = os.path.join(root, name)
            tid = track_id(full)
            tags = read_tags(full)
            try:
                size = os.path.getsize(full)
            except Exception:
                size = 0
            tracks.append({
                'id': tid, 'path': full, 'filename': name,
                'title': tags['title'], 'artist': tags['artist'], 'album': tags['album'],
                'ext': os.path.splitext(name)[1].lower().lstrip('.'), 'size': size,
            })
    tracks.sort(key=lambda t: (t['artist'].lower(), t['title'].lower()))
    cache['folder'] = folder
    cache['tracks'] = tracks
    # Drop analysis for files no longer present.
    ids_now = {t['id'] for t in tracks}
    cache['analysis'] = {k: v for k, v in cache.get('analysis', {}).items() if k in ids_now}
    save_cache(cache)
    return cache

def path_for_id(tid):
    cache = load_cache()
    for t in cache.get('tracks', []):
        if t['id'] == tid:
            p = t['path']
            return p if os.path.isfile(p) else None
    return None

def save_analysis(items):
    """items: list of {id, bpm, key, mode, camelot, energy, duration}."""
    cache = load_cache()
    a = cache.get('analysis', {})
    for it in items:
        tid = it.get('id')
        if not tid:
            continue
        a[tid] = {k: it[k] for k in ('bpm', 'key', 'mode', 'camelot', 'energy', 'duration') if k in it}
    cache['analysis'] = a
    save_cache(cache)
    return True

def save_playlists(playlists):
    cache = load_cache()
    cache['playlists'] = playlists or []
    save_cache(cache)
    return True

def save_bindings(bindings):
    cache = load_cache()
    cache['bindings'] = bindings or {}
    save_cache(cache)
    return True

CONTENT_TYPES = {
    'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'mp4': 'audio/mp4', 'aac': 'audio/aac',
    'flac': 'audio/flac', 'wav': 'audio/wav', 'aiff': 'audio/aiff', 'aif': 'audio/aiff',
    'ogg': 'audio/ogg', 'oga': 'audio/ogg', 'opus': 'audio/opus',
}

def content_type_for(path):
    return CONTENT_TYPES.get(os.path.splitext(path)[1].lower().lstrip('.'), 'application/octet-stream')
