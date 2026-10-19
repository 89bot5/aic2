# aic2

A small, private, text-only chat app for [abliteration.ai](https://abliteration.ai)
(or any OpenAI-compatible API). Runs on your own computer or server.

- Chats in a sidebar, with rename, delete, a per-chat system prompt (gear icon)
  and reasoning level (gauge icon)
- Streaming replies with Stop, Retry, Copy and per-message delete
- Markdown, dark mode, mobile layout
- Everything is stored in one SQLite file. No database server, no telemetry,
  and the page never contacts any site except your own server.

**Text only.** Images and file attachments aren't supported.
**Reasoning levels** (Low / High / Max) only work with GLM 5.3; leave them on Default for other models.

## Run it on your computer

1. Install [Node.js](https://nodejs.org) 20 or newer (the LTS version is fine).
2. Get the project. Either download it (green **Code** button → **Download ZIP**, unzip it,
   and open a terminal in the unzipped folder), or in a terminal run:
   ```bash
   git clone https://github.com/89bot5/aic2.git
   cd aic2
   ```
   `git clone` makes a new `aic2` folder wherever you run it, so the `cd aic2` matters.
3. Install and start:
   ```bash
   npm install
   npm start
   ```
4. Open <http://localhost:3000>.
   - The first time, it asks you to **create a password**.
   - Then it asks for your **API key**. You can change it any time with the key icon
     at the bottom left, next to *Log out*.

Leave the terminal open while you use it. Press `Ctrl+C` to stop.

### Good to know

- Your chats, password (hashed) and API key are stored in the `data` folder inside the project.
  Back it up if you care about your chats; delete it to start completely fresh.
- Forgot your password? Stop the app, run `npm run reset-password`, start it again,
  and the page will ask you to create a new one. Your chats are kept.
- Port 3000 taken? Use another: `PORT=3001 npm start`
  (Windows PowerShell: `$env:PORT=3001; npm start`).
- To update: download the new version (or `git pull`), then `npm install` and start again.
  Your `data` folder carries over.

## Optional settings

All optional, set as environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. The default only accepts connections from this computer |
| `DATA_DIR` | `./data` | Where the database is stored |
| `API_BASE_URL` | `https://api.abliteration.ai/v1` | Any OpenAI-compatible endpoint |
| `MODEL` | `abliterated-model-large-v2` | Default model (can also be changed in the key dialog) |
| `BASE_PATH` | *(empty)* | Serve under a subpath, e.g. `/aic` |

## Run it on a server (Debian/Ubuntu)

**Important:** until a password is created, whoever opens the page first gets to set it.
Do the first visit yourself right after starting the service.

```bash
sudo apt install -y nodejs npm
sudo useradd --system --no-create-home --shell /usr/sbin/nologin chatapp
git clone https://github.com/89bot5/aic2.git /opt/aic2
cd /opt/aic2 && sudo npm ci --omit=dev
sed "s#APP_DIR#$(pwd)#g" deploy/chatapp.service | sudo tee /etc/systemd/system/aic2.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now aic2
```

Data lives in `/var/lib/aic2`. To reset the password on a server:
```bash
sudo systemctl stop aic2
sudo -u chatapp env DATA_DIR=/var/lib/aic2 node /opt/aic2/server.js --reset-password
sudo systemctl start aic2
```

### Reverse proxy

The app speaks plain HTTP on `127.0.0.1:3000`; put it behind your HTTPS web server.
Pass the real client IP (used for the login lockout) and the scheme (so the login cookie is marked secure).

nginx:
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

Apache (`sudo a2enmod proxy proxy_http headers`), inside the `<VirtualHost *:443>` block:
```apache
ProxyAddHeaders Off
RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"
RequestHeader set X-Forwarded-Proto "https"
SetEnvIf Request_URI "/api/" no-gzip=1
ProxyPass        / http://127.0.0.1:3000/ flushpackets=on timeout=300
ProxyPassReverse / http://127.0.0.1:3000/
```

For a subpath such as `/aic/`, set `BASE_PATH=/aic` in the service file and use
`location /aic/` (nginx) or `ProxyPass /aic/ http://127.0.0.1:3000/aic/` (Apache).

### Updating

```bash
cd /opt/aic2 && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart aic2
```
