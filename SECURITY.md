# Security Policy

## Threat model

`dsh-use-codex` lets a DSH tool call start the local Codex CLI. The person or agent controlling DSH can therefore request local code execution within the configured boundary.

Only install this plugin in a trusted local DSH instance. Do not expose DSH or the plugin to untrusted users.

## Defaults

- `enabled: false` in the public bundle patch
- `workspace-write` sandbox for normal runs
- `danger-full-access` disabled unless the host explicitly enables it
- Required working directory must resolve inside `allowedRoots`
- Symlink escapes are rejected
- The task is passed as an argv value without a shell
- Timeouts terminate the Codex process group
- Tasks, working directories, and outputs are not persisted by the plugin

## Operator responsibilities

- Keep `allowedRoots` as narrow as possible
- Do not set `allowDangerFullAccess: true` unless the host is externally isolated
- Review Codex configuration and provider endpoints
- Treat inherited environment variables as available to the Codex child process
- Keep Codex CLI and DSH updated

## Reporting

Please report vulnerabilities through the GitHub repository's private security advisory channel rather than a public issue. Include reproduction steps, affected versions, and the expected impact.
