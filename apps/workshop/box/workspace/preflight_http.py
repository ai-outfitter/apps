"""Process a single native analysis at a time on the runner's private listener."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import subprocess
import sys


class PreflightHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/preflight":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 41_000_000:
            self.send_error(413)
            return
        data = self.rfile.read(length)
        try:
            result = subprocess.run([sys.executable, "/opt/workshop/preflight.py"],
                                    input=data, capture_output=True, timeout=300)
            if result.returncode:
                self.send_error(422, "Native tools could not inspect this artifact")
                return
            json.loads(result.stdout)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result.stdout)))
            self.end_headers()
            self.wfile.write(result.stdout)
        except subprocess.TimeoutExpired:
            self.send_error(504, "Fabrication preflight timed out")


if __name__ == "__main__":
    HTTPServer((os.environ.get("PREFLIGHT_LISTEN", "127.0.0.1"), 4041), PreflightHandler).serve_forever()
