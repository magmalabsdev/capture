#!/usr/bin/env python3
"""Minimal static dev server for the Capture recorder.

Capture APIs (getUserMedia / getDisplayMedia) and ffmpeg.wasm need an
http(s) origin (they do NOT work from file://). The single-thread ffmpeg
core does not require SharedArrayBuffer, so no COOP/COEP headers are needed.

Usage:
    python3 serve.py [port]      # default 8000
    python3 serve.py 8080 --coep # also send COOP/COEP (only needed for
                                 # the multi-thread ffmpeg core)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    cross_origin_isolation = False

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".css": "text/css",
    }

    def end_headers(self):
        # Avoid stale module/wasm caching during development.
        self.send_header("Cache-Control", "no-store")
        if self.cross_origin_isolation:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


def main():
    args = [a for a in sys.argv[1:]]
    coep = "--coep" in args
    args = [a for a in args if not a.startswith("--")]
    port = int(args[0]) if args else 8000

    Handler.cross_origin_isolation = coep
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    iso = " (cross-origin isolated)" if coep else ""
    print(f"Capture dev server → http://localhost:{port}{iso}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
