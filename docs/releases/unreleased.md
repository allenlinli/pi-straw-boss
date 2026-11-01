# pi-straw-boss, unreleased

## Control socket handshake (protocol 2)

- The first session after the update restarts the sb server: a server of the earlier control protocol cannot take the new handshake, so a newer session ends it by signal and starts a new one. A sidecar of an earlier version is ended by `join` the same way.
- The control socket never carries the secret: both sides prove they know it with a mutual challenge. A sidecar released before this one answers the new commands with "no net sidecar" until it is restarted.
- `server.json` gains `proto`.
