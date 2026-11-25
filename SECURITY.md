# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.1.x` (`main`) | Yes |

## Reporting a Vulnerability

Please do not disclose security vulnerabilities in public GitHub issues.

Report vulnerabilities privately via:

- Email: `subh@intenthost.com`
- GitHub Security Advisories on `https://github.com/intenthost/pgsa`

Include reproduction steps, affected files or endpoints, and potential impact. You will receive an acknowledgment and remediation timeline as soon as possible.

## Production Deployment Guidance

- **Serve over HTTPS with `PGSA_SECURE_COOKIES=true`**: `compose.yaml` binds exclusively to `127.0.0.1:3000`. Terminate TLS at a reverse proxy (e.g., Caddy, Nginx, or Cloudflare Tunnel) and set `PGSA_SECURE_COOKIES="true"` so `pgsa_session` cookies are marked `Secure`.
- **Enforce TLS to remote PostgreSQL**: Include `?sslmode=verify-full` in `DATABASE_URL` when connecting to PostgreSQL over untrusted or public networks.
- **Use least-privilege credentials & rotate `.env`**: Changing `DATABASE_URL`, `PGSA_USERNAME`, or `PGSA_PASSWORD` immediately invalidates all previously signed `pgsa_session` cookies.
