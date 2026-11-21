from argparse import ArgumentParser
from functools import partial
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from tempfile import NamedTemporaryFile
from threading import Lock, Timer
from urllib.parse import urlsplit
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
LAYOUT = ROOT / "desktop-layout.json"
BRANCH = "main"
EXPECTED_REMOTES = {
    "git@github.com:tatianaegoshina/crazy-random-design.git",
    "https://github.com/tatianaegoshina/crazy-random-design",
    "https://github.com/tatianaegoshina/crazy-random-design.git",
}
LOCAL_FILES = {
    "/gallery.js", "/desktop-layout.json", "/editor/editor.js", "/editor/editor.css",
}
MEDIA_FILE = re.compile(r"/media/[a-z0-9][a-z0-9.-]*\.(?:webp|gif|mp4)")


class WorkIDs(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.ids = set()
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        if tag in {"img", "source"}:
            source = dict(attrs).get("src")
            if source and MEDIA_FILE.fullmatch("/" + source):
                self.ids.add(source)


def validate_layout(payload):
    positions = payload.get("positions") if isinstance(payload, dict) else None
    expected = WorkIDs((ROOT / "index.html").read_text(encoding="utf-8")).ids
    if not isinstance(positions, dict) or positions.keys() != expected:
        raise ValueError("Список работ изменился. Перезагрузи редактор и повтори публикацию.")
    if "hidden" in payload:
        hidden = payload["hidden"]
    else:
        published = json.loads(LAYOUT.read_text(encoding="utf-8"))
        hidden = [id for id in published.get("hidden", []) if id in expected]
    if (not isinstance(hidden, list) or any(type(id) is not str or id not in expected for id in hidden)
            or len(hidden) != len(set(hidden))):
        raise ValueError("В списке удалённых работ есть некорректные элементы.")
    for position in positions.values():
        if not isinstance(position, list) or len(position) not in (3, 4) or any(type(value) is not int for value in position):
            raise ValueError("В раскладке есть некорректные координаты.")
        x, y, width, *orientation = position
        if not (0 <= x and 0 <= y <= 200000 and 60 <= width and x + width <= 1000):
            raise ValueError("В раскладке есть работы за пределами холста.")
        if orientation and orientation[0] not in (0, 90, 180, 270):
            raise ValueError("В раскладке есть некорректный угол поворота.")
    return {"positions": positions, "hidden": hidden}


def git(*args, check=True):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    command = ["git", "-c", "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10", *args]
    return subprocess.run(command, cwd=ROOT, env=env, check=check, capture_output=True, text=True, timeout=50)


def publish_layout(payload):
    layout = validate_layout(payload)
    if git("branch", "--show-current").stdout.strip() != BRANCH:
        raise ValueError("Открой ветку main в папке проекта и повтори публикацию.")
    if git("remote", "get-url", "--push", "origin").stdout.strip() not in EXPECTED_REMOTES:
        raise ValueError("Адрес GitHub-репозитория в проекте изменился.")

    git("fetch", "origin", BRANCH)
    remote = f"origin/{BRANCH}"
    if git("merge-base", "--is-ancestor", remote, "HEAD", check=False).returncode:
        raise ValueError("На GitHub появилась более свежая версия проекта. Обнови локальную ветку перед публикацией.")
    pending = git("diff", "--name-only", remote, "HEAD").stdout.splitlines()
    if set(pending) - {LAYOUT.name}:
        raise ValueError("В ветке есть другие неопубликованные коммиты. Черновик раскладки сохранён в браузере.")

    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=ROOT, prefix=".layout-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(layout, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.close()
            temporary.replace(LAYOUT)
        finally:
            temporary.unlink(missing_ok=True)

    if git("diff", "--quiet", "HEAD", "--", LAYOUT.name, check=False).returncode == 1:
        git("-c", "user.email=60257571+tatianaegoshina@users.noreply.github.com",
            "commit", "--only", "-m", "Arrange the desktop gallery", "--", LAYOUT.name)
    git("push", "origin", f"HEAD:refs/heads/{BRANCH}")


class EditorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                         "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def send_body(self, content, content_type, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def json_response(self, payload, status=HTTPStatus.OK):
        self.send_body(json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

    def allowed_host(self):
        return self.headers.get("Host") == self.server.host_header

    def send_head(self):
        if not self.allowed_host():
            self.send_error(HTTPStatus.FORBIDDEN)
            return None
        route = urlsplit(self.path).path
        if route == "/":
            page = (ROOT / "index.html").read_text(encoding="utf-8")
            editor = f'<meta name="layout-editor-token" content="{self.server.editor_token}">\n'
            editor += '<link rel="stylesheet" href="/editor/editor.css">\n'
            body = page.replace("</head>", editor + "</head>", 1)
            self.send_body(body.encode(), "text/html; charset=utf-8")
            return None
        if route in LOCAL_FILES or MEDIA_FILE.fullmatch(route):
            target = ROOT / route.lstrip("/")
            if target.is_file() and target.resolve().is_relative_to(ROOT):
                return super().send_head()
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def do_POST(self):
        if self.path != "/publish":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if (not self.allowed_host()
                or self.headers.get("Origin") != self.server.editor_origin
                or not secrets.compare_digest(self.headers.get("X-Editor-Token", ""), self.server.editor_token)):
            self.json_response({"error": "Перезагрузи редактор и повтори публикацию."}, HTTPStatus.FORBIDDEN)
            return
        length = self.headers.get("Content-Length", "")
        if (self.headers.get_content_type() != "application/json"
                or not length.isascii() or not length.isdecimal() or len(length) > 6
                or not 0 < int(length) <= 131072):
            self.json_response({"error": "Некорректный запрос публикации."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            payload = json.loads(self.rfile.read(int(length)))
            with self.server.publish_lock:
                publish_layout(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.json_response({"error": "Не удалось прочитать раскладку."}, HTTPStatus.BAD_REQUEST)
        except ValueError as error:
            self.json_response({"error": str(error)}, HTTPStatus.CONFLICT)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            self.log_error("Publishing failed: %s", getattr(error, "stderr", None) or error)
            self.json_response({"error": "GitHub не принял публикацию. Черновик сохранён. Попробуй ещё раз."},
                               HTTPStatus.BAD_GATEWAY)
        else:
            self.json_response({"ok": True})


def main():
    parser = ArgumentParser(description="Локальный редактор crazy random design")
    parser.add_argument("--port", type=int, default=42183)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), EditorHandler) as server:
        server.host_header = f"127.0.0.1:{server.server_port}"
        server.editor_origin = f"http://{server.host_header}"
        server.editor_token = secrets.token_hex(24)
        server.publish_lock = Lock()
        print(f"Редактор открыт по адресу {server.editor_origin}/", flush=True)
        print("Оставь это окно открытым, пока редактируешь лендинг.", flush=True)
        if not args.no_browser:
            Timer(0.35, partial(webbrowser.open, server.editor_origin + "/")).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
