# Umami analytics (Fly + Neon)

Privacy-friendly analytics for **forwardslashdot.com**, hosted at
`https://analytics.forwardslashdot.com`.

| Item | Value |
| --- | --- |
| Fly app | `forwardslashdot-umami` |
| Image | `ghcr.io/umami-software/umami:postgresql-latest` |
| DB | Neon Postgres (`DATABASE_URL` Fly secret) |
| Auth | `APP_SECRET` Fly secret |

## Secrets (names only — never commit values)

| Name | Where |
| --- | --- |
| `DATABASE_URL` | Fly app `forwardslashdot-umami` (Neon connection string) |
| `APP_SECRET` | Fly app (random hex; `openssl rand -hex 32`) |

Prefer a dedicated Neon database named `umami` after Kevin claims the Neon
project. Until then, Umami may share the claim project's `neondb` (public
schema) while domain-checker metrics use schema `domain_checker`.

## Deploy

```bash
cd services/umami
fly apps create forwardslashdot-umami --org personal   # once
fly secrets set DATABASE_URL=... APP_SECRET=... -a forwardslashdot-umami
fly deploy -a forwardslashdot-umami
```

Default login is `admin` / `umami` — change the password immediately.
