#!/usr/bin/env python3
"""Serve a website folder plus the device viewer, from one address.

    python3 serve.py <site folder> [port]

The site is served at its own paths (/, /about.html, ...) and the viewer at
/__device-views/. Both come from the same address, so the viewer can follow
each frame's scroll position. Nothing is written to the site folder.
Standard library only; listens on 127.0.0.1 so it can't be reached from
other machines.
"""
import json
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
PREFIX = '/__device-views/'
SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache'}
MAX_PAGES = 300  # enough for the page picker; bigger sites are usually generated archives
DEFAULT_PORT = 8787  # rarely used by dev servers (Vite 5173, Next 3000, Astro 4321)
PORT_TRIES = 20  # if the port is busy, try the next few before giving up


def list_pages(root):
    pages = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith('.'))
        for f in sorted(files):
            if f.endswith(('.html', '.htm')):
                rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
                pages.append('/' + rel)
                if len(pages) >= MAX_PAGES:
                    return pages
    # Home page first
    pages.sort(key=lambda p: (p != '/index.html', p.count('/'), p))
    return pages


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, site_root, **kwargs):
        self.site_root = site_root
        super().__init__(*args, directory=site_root, **kwargs)

    def end_headers(self):
        # Always show the latest version of the site after a change
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/__device-views', PREFIX):
            self.send_response(302)
            self.send_header('Location', PREFIX + 'viewer.html')
            self.end_headers()
            return
        if path == PREFIX + 'viewer.html':
            return self._send_file(os.path.join(HERE, 'viewer.html'), 'text/html; charset=utf-8')
        if path == PREFIX + 'pages.json':
            body = json.dumps(list_pages(self.site_root)).encode('utf-8')
            return self._send(body, 'application/json')
        if path.startswith(PREFIX):
            self.send_error(404)
            return
        return super().do_GET()

    def _send_file(self, file_path, ctype):
        with open(file_path, 'rb') as fh:
            self._send(fh.read(), ctype)

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    if len(sys.argv) < 2:
        sys.exit('Usage: python3 serve.py <site folder> [port]')
    root = os.path.abspath(sys.argv[1])
    if not os.path.isdir(root):
        sys.exit('Not a folder: ' + root)
    try:
        port = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PORT
    except ValueError:
        sys.exit('The port must be a number, for example 8787')
    server = None
    for p in range(port, port + PORT_TRIES):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', p), partial(Handler, site_root=root))
            port = p
            break
        except OSError:
            continue  # port in use: try the next one
    if server is None:
        sys.exit('Ports %d to %d are all in use. Pass a different port.' % (port, port + PORT_TRIES - 1))
    print('Serving ' + root)
    print('Viewer: http://127.0.0.1:%d%sviewer.html' % (port, PREFIX), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
