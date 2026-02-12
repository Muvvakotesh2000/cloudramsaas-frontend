import os
from flask import Flask, render_template, jsonify

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)

@app.route("/config")
def config():
    return jsonify({
        "SUPABASE_URL": os.getenv("SUPABASE_URL", ""),
        "SUPABASE_ANON_KEY": os.getenv("SUPABASE_ANON_KEY", ""),
        "API_BASE_URL": os.getenv("API_BASE_URL", ""),  # backend public url later
    })

@app.route("/")
@app.route("/login")
@app.route("/register")
@app.route("/callback")
@app.route("/allocate")
def spa():
    return render_template("index.html")

@app.route("/status")
def status():
    return render_template("status.html")

if __name__ == "__main__":
    app.run(debug=True, port=5000)
