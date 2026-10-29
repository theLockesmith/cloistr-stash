# Design

`internal/server/cors.go`: `corsMiddleware` wraps the whole handler, outside
metrics and the rate limiter, so a 429 still names the origin (Space sees the
status, not an opaque CORS failure) and a preflight spends no token. Every
response to a request with an Origin gets `Vary: Origin`.

Deploy: cloistr-config `base/drive/configmap.yaml` sets
`DRIVE_CORS_ORIGINS: https://space.cloistr.xyz` (staging is generated from
base by gen_staging.py).
