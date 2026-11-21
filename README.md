# github-core-clone-01

[![make.fun bounty](https://make.fun/bounty/github-core-clone-01/badge.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun](https://make.fun/badge.svg)](https://make.fun)

A GitHub-compatible git forge in one Node 22 process, standard library only — built for the
[make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

It serves, from a single in-memory store with no UI, no git binary and no network:

- **git smart HTTP** — upload-pack protocol v2 (with v0 fallback) and receive-pack v0,
  packfile parsing (including REF/OFS deltas) and generation via `node:zlib`, fast-forward-only
  pushes with per-ref `ok`/`ng` report-status.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels, issues,
  comments, pull requests, files and squash merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send, plus
  introspection, cursor pagination and Relay global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 (`server/discover`)
  with the legacy `initialize` handshake, six tools acting on the same store as REST.

## Run it

```sh
node main.ts
```

`main.ts` is the entry lifecycle: it binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL`, and exits 0 when the suite says it is done. `app.ts` is the forge itself.
Node 22.18+ only; there is nothing to install.

## Layout

- `main.ts` — lifecycle (bind, register, wait for done). Kept as the starter ships it.
- `app.ts` — the whole forge: git objects/packs, the store, REST, GraphQL and MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Notes

- The token owner's login is the contest scenario's fixed viewer, `adaiversen` (derived from the
  kit's public constant scenario seed); any other owner answers 404, never 403.
- All timestamps are deterministic (a fixed epoch plus a sequence counter), so two runs on the
  same instance leave the same state export.
