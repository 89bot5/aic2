# ai-chat-interface

A small self-hosted, text-only chat UI for any OpenAI-compatible API (built for abliteration.ai).

- Password login, with a 15-minute lockout after 5 wrong attempts per IP
- Separate chats in a resizable, collapsible sidebar, with rename and delete, stored in Postgres
- A per-chat system prompt (cog icon) and reasoning effort (gauge icon: Default, Low, High, Max) on each chat row
- Streaming replies, Stop, Retry, Copy, delete any single message, and a collapsible "Thinking" section for reasoning models
- Markdown rendering, dark mode, and a mobile layout
- Node.js with three dependencies (`pg`, `marked`, `dompurify`), no build step, no telemetry,
  and no third-party requests from the browser

## Layout

| Path | What it is |
|---|---|
| `server.js` | HTTP server: login, chat storage, streaming from the model API |
| `public/` | The page (HTML, CSS, JS) |
| `deploy/chatapp.env.example` | Config template (copy to `/etc/chatapp.env`) |
| `deploy/chatapp.service` | systemd unit |

All configuration is through environment variables. The database tables are created on first start.

## Install (Debian)

`APP_DIR` below is wherever you cloned this repo, e.g. `/var/www/html/aic`.

```bash
sudo apt install -y nodejs npm
sudo useradd --system --no-create-home --shell /usr/sbin/nologin chatapp
cd APP_DIR && npm ci --omit=dev

sudo -u postgres psql -c "CREATE USER chatapp WITH PASSWORD 'db-password';" -c "CREATE DATABASE chatapp OWNER chatapp;"

sudo cp deploy/chatapp.env.example /etc/chatapp.env
sudo chmod 600 /etc/chatapp.env
sudo nano /etc/chatapp.env        # fill in the values

sed "s#APP_DIR#$(pwd)#g" deploy/chatapp.service | sudo tee /etc/systemd/system/chatapp.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now chatapp
```

## nginx

```nginx
location /aic/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

`X-Forwarded-For $remote_addr` matters: the login lockout uses it to tell visitors apart.
`proxy_pass` has no trailing path on purpose; the app strips `BASE_PATH` itself.
To serve at the site root instead, use `location /` and leave `BASE_PATH` empty.

## Apache (instead of nginx)

```bash
sudo a2enmod proxy proxy_http headers
```

Inside the site's `<VirtualHost *:443>` block:

```apache
RedirectMatch 301 ^/aic$ /aic/
ProxyAddHeaders Off
RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"
SetEnvIf Request_URI "^/aic/api/" no-gzip=1
ProxyPass        /aic/ http://127.0.0.1:3000/aic/ flushpackets=on timeout=300
ProxyPassReverse /aic/ http://127.0.0.1:3000/aic/
```

Then `sudo apache2ctl configtest && sudo systemctl reload apache2`.
`ProxyAddHeaders Off` plus the `RequestHeader` line ensure `X-Forwarded-For` holds only the real
client IP, so the login lockout can't be dodged with a forged header.

## Updating

```bash
cd APP_DIR && git pull && npm ci --omit=dev && sudo systemctl restart chatapp
```

## Notes

- Changing `APP_PASSWORD` or `SESSION_SECRET` and restarting logs out every session.
- On touch devices, Enter inserts a new line; tap the arrow to send.
