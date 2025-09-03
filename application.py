# app.py
# ───────────────────────────────────────────────────────────────────
# Structure Homes AI — Landing + Auth + Simple APIs (no TensorFlow)
# ───────────────────────────────────────────────────────────────────
import os, json, sqlite3
from contextlib import closing
from functools import wraps

from flask import (
    Flask, request, jsonify, render_template, redirect,
    url_for, session, flash, send_file, abort
)
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

# ───────────────────────────────────────────────────────────────────
# App + CORS
# ───────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
CORS(app, resources={r"/*": {"origins": "*"}})

ROOT_DIR       = os.path.abspath("./")
DB_PATH        = os.path.join(ROOT_DIR, "users.db")

# ───────────────────────────────────────────────────────────────────
# DB helpers
# ───────────────────────────────────────────────────────────────────
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with closing(db()) as con:
        con.execute("""
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            tokens_remaining INTEGER NOT NULL DEFAULT 20,
            is_admin INTEGER NOT NULL DEFAULT 0
        )
        """)
        con.commit()

        # Seed demo user if missing
        cur = con.execute("SELECT id FROM users WHERE username=?", ("griffin",))
        if cur.fetchone() is None:
            con.execute(
                "INSERT INTO users(username, password_hash, tokens_remaining, is_admin) VALUES(?,?,?,?)",
                ("griffin", generate_password_hash("griffin@123"), 20, 0)
            )
            con.commit()

        # Ensure requested accounts
        seed_or_update_user("griffin", "griffin@123", tokens=20,    is_admin=False)
        seed_or_update_user("admin",   "admin@123",   tokens=10000, is_admin=True)
        seed_or_update_user("YCdemo",  "YCdemo@123",  tokens=50,    is_admin=False)

def get_user_by_username(username):
    with closing(db()) as con:
        cur = con.execute("SELECT * FROM users WHERE username=?", (username,))
        return cur.fetchone()

def get_user_by_id(uid):
    with closing(db()) as con:
        cur = con.execute("SELECT * FROM users WHERE id=?", (uid,))
        return cur.fetchone()

def set_tokens(username, tokens):
    with closing(db()) as con:
        con.execute("UPDATE users SET tokens_remaining=? WHERE username=?", (tokens, username))
        con.commit()

from werkzeug.security import generate_password_hash
def seed_or_update_user(username: str, password: str, tokens: int, is_admin: bool):
    """Create or update a user by username. If password is None, keep the old password."""
    with closing(db()) as con:
        cur = con.execute("SELECT id FROM users WHERE username=?", (username,))
        row = cur.fetchone()
        if row is None:
            con.execute(
                "INSERT INTO users(username, password_hash, tokens_remaining, is_admin) VALUES(?,?,?,?)",
                (username, generate_password_hash(password or "changeme"), int(tokens), 1 if is_admin else 0)
            )
        else:
            if password:
                con.execute(
                    "UPDATE users SET password_hash=?, tokens_remaining=?, is_admin=? WHERE username=?",
                    (generate_password_hash(password), int(tokens), 1 if is_admin else 0, username)
                )
            else:
                con.execute(
                    "UPDATE users SET tokens_remaining=?, is_admin=? WHERE username=?",
                    (int(tokens), 1 if is_admin else 0, username)
                )
        con.commit()

# Put a strong secret in your environment:  ADMIN_BOOTSTRAP_TOKEN=yourlongsecret
@app.route("/_seed_defaults")
def seed_defaults():
    token = request.args.get("token")
    if token != os.environ.get("ADMIN_BOOTSTRAP_TOKEN"):
        return ("forbidden", 403)

    seed_or_update_user("griffin", "griffin@123", tokens=20,    is_admin=False)
    seed_or_update_user("admin",   "admin@123",   tokens=10000, is_admin=True)
    seed_or_update_user("YCdemo",  "YCdemo@123",  tokens=50,    is_admin=False)
    return "seeded", 200

# ───────────────────────────────────────────────────────────────────
# Auth utilities
# ───────────────────────────────────────────────────────────────────
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "uid" not in session:
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper

@app.context_processor
def inject_user():
    user = get_user_by_id(session["uid"]) if session.get("uid") else None
    return { "current_user": dict(user) if user else None }

# ───────────────────────────────────────────────────────────────────
# Example image/file serving (optional)
# ───────────────────────────────────────────────────────────────────
EXAMPLE_FILES = {
    "ex1-floor1.png": "/home/sejain/repos/FloorPlanTo3D-API/images/ex1-floor1.png",
    "ex1-floor2.png": "/home/sejain/repos/FloorPlanTo3D-API/images/ex1-floor2.png",
    "ex1-floor3.png": "/home/sejain/repos/FloorPlanTo3D-API/images/ex1-floor3.png",
    "ex2-floor1.png": "/home/sejain/repos/FloorPlanTo3D-API/images/ex2-floor1.png",
}

@app.route("/examples/<name>")
def get_example(name):
    path = EXAMPLE_FILES.get(name)
    if not path or not os.path.exists(path):
        return abort(404)
    mt = "image/png" if name.lower().endswith(".png") else "image/jpeg"
    return send_file(path, mimetype=mt)

# ───────────────────────────────────────────────────────────────────
# Pages
# ───────────────────────────────────────────────────────────────────
@app.before_first_request
def warmup():
    init_db()
    print("✅  DB ready (no ML loaded)")

@app.route("/")
def landing():
    # index.html is your marketing/landing page
    return render_template("index.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        row = get_user_by_username(username)
        if not row or not check_password_hash(row["password_hash"], password):
            flash("Invalid username or password", "error")
            return render_template("login.html"), 401
        session["uid"] = row["id"]
        nxt = request.args.get("next") or url_for("demo")
        return redirect(nxt)
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))

@app.route("/demo")
@login_required
def demo():
    return render_template("demo.html")

@app.route("/map")
@login_required
def map_view():
    return render_template("map.html")

# REST helper for header badge
@app.route("/api/me")
@login_required
def api_me():
    user = get_user_by_id(session["uid"])
    return jsonify(
        username=user["username"],
        tokens_remaining=user["tokens_remaining"],
        is_admin=bool(user["is_admin"])
    )

# Minimal admin (optional): set tokens via POST (form or JSON)
@app.route("/admin", methods=["GET", "POST"])
@login_required
def admin():
    me = get_user_by_id(session["uid"])
    if not me["is_admin"]:
        return abort(403)

    msg = None
    if request.method == "POST":
        payload = request.form or request.json or {}
        username = (payload.get("username") or "").strip()
        try:
            tokens = int(payload.get("tokens") or 0)
        except Exception:
            tokens = 0
        if not username:
            msg = "Username required"
        else:
            try:
                set_tokens(username, tokens)
                msg = f"Updated {username} → {tokens} tokens"
            except Exception as e:
                msg = f"Error: {e}"

    with closing(db()) as con:
        rows = con.execute("SELECT username, tokens_remaining, is_admin FROM users ORDER BY username").fetchall()
    return render_template("admin.html", rows=rows, message=msg)

# ───────────────────────────────────────────────────────────────────
# Simple demo APIs (GET/POST) for your frontend to call
# ───────────────────────────────────────────────────────────────────
@app.route("/api/echo", methods=["GET"])
def api_echo():
    """Echo back query params. Example: /api/echo?msg=hi"""
    return jsonify(ok=True, query=dict(request.args))

@app.route("/api/submit", methods=["POST"])
def api_submit():
    """
    Accepts JSON or form-encoded data and returns it.
    Use this as a template for your own POST handlers.
    """
    if request.is_json:
        data = request.get_json(silent=True) or {}
        src = "json"
    else:
        data = request.form.to_dict(flat=True)
        src = "form"
    return jsonify(ok=True, source=src, data=data)

# Optional: simple file upload (saved to ./uploads)
UPLOAD_DIR = os.path.join(ROOT_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.route("/api/upload", methods=["POST"])
@login_required
def api_upload():
    if "file" not in request.files:
        return jsonify(ok=False, error="field 'file' missing"), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify(ok=False, error="empty filename"), 400
    save_path = os.path.join(UPLOAD_DIR, f.filename)
    f.save(save_path)
    return jsonify(ok=True, filename=f.filename, path=save_path)

