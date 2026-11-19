# odyssey deployment

How this fork runs on my home server. Actual Budget and Ollama run on the same
host, bound to localhost, so the container uses host networking.

| File | Installed to |
|---|---|
| `docker-compose.yml` | `/opt/actual-ai/docker-compose.yml` |
| `.env.example` | `/opt/actual-ai/.env` (real values, mode 600, not in git) |
| `actual-ai.cron` | `/etc/cron.d/actual-ai` |

Log: `/var/log/actual-ai.log`.

Still uses the upstream image; switching to an image built from this fork is a
later step.
