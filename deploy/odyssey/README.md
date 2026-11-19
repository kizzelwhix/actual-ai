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

## Prompt override (2026-11-19)

`docker-compose.yml` sets `PROMPT_TEMPLATE` to upstream 3.3.2's `src/templates/prompt.hbs` with one
change: category **groups** are listed without IDs. With group IDs in the prompt, the 4B model often
returned a group's ID (mostly "Income"); the app rejects it and leaves the transaction uncategorised.

Backtest (`eval/backtest.mjs`, 249 transactions since 2026-08-01, history before each date only,
`frob/qwen3.5-instruct:4b`, temperature 0):

| Prompt | Accuracy | Invalid IDs |
|---|---|---|
| upstream default | 79.9% | 31 group IDs |
| groups without IDs (deployed) | 94.0% | 0 |

The image is pinned to `3.3.2` because the template depends on that version's variables. To upgrade:
regenerate the template from the new `prompt.hbs`, re-run the backtest, then bump the tag.
