# Task 0.3 spike: GitHub Releases browser CORS verification

Decides whether the configurator (static site on GitHub Pages, origin
`https://novax-alux.github.io`, cross-origin from `github.com`) can
`fetch()` firmware release assets and `manifest.json` **directly** from
`novaX-ALUX/flight_controller`'s GitHub Releases, or must mirror them into
the site's own `public/`.

**Verdict: 视资源类型而定 (mixed) — 需镜像 for the parts that matter.**
`api.github.com` (release/asset *metadata*) sends `Access-Control-Allow-Origin: *`
and is directly fetchable. **`release-assets.githubusercontent.com` — the
actual byte payload of every release asset, regardless of file type (tested
directly on `.apj` and `.hex`, corroborated on a `.txt` from an unrelated
repo; a `manifest.json` release asset would land on the same CDN and is
expected to behave identically) — never sends any `Access-Control-Allow-Origin`
header**, confirmed on two independent public repos. A browser `fetch()` in
default `cors` mode against that host will
reject with a network error; the bytes cannot be read into JS. This is a
bigger finding than the task brief's framing suggests: it doesn't just
block a mirrored-metadata fallback, it blocks **reading firmware bytes into
memory for WebUSB/serial flashing**, which §7 of the design doc requires
(programmatic DFU/bootloader flashing needs an `ArrayBuffer` in JS, not a
browser-native download). See "Correction to the existing design
assumption" below.

## Repo visibility (checked first)

```
$ gh repo view novaX-ALUX/flight_controller --json visibility,url
{"url":"https://github.com/novaX-ALUX/flight_controller","visibility":"PUBLIC"}
```

The repo is **public today** (16 tags, latest release `AF-F4_T10_nano-v0.3.4`,
2 assets: `.apj` + `_with_bl.hex`, no `manifest.json` asset yet — that's
Task 1.1). Findings below were measured against this real repo. Private-repo
implications are covered separately since visibility could change.

## Method

`curl -sD -` with `-H "Origin: https://novax-alux.github.io"` at each hop of
the redirect chain, checking for `Access-Control-Allow-Origin` and related
headers. This is standard, sufficient evidence for CORS: the browser's CORS
check is purely a response-header check performed by the browser after a
real HTTP response arrives — `curl` receiving the same headers a browser
would receive is exactly what determines whether the browser blocks the
response. Also ran a Node 18+ `fetch()` for corroboration, with the
limitation stated honestly: **Node's `fetch()` does not enforce CORS at
all** (CORS is a browser-only security policy, not part of HTTP itself), so
Node fetch succeeding is not evidence the browser would allow it — it's
useful here only to confirm the *absence* of the CORS header on the final
response (`access-control-allow-origin` printed as `null`).

## Evidence

### Hop 1: `github.com/.../releases/download/...` (302 redirect)

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" \
  "https://github.com/novaX-ALUX/flight_controller/releases/download/AF-F4_T10_nano-v0.3.4/AF-F4_T10_nano-v0.3.4.apj"

HTTP/2 302
location: https://release-assets.githubusercontent.com/github-production-release-asset/1179426748/...(signed URL, ~15 min expiry)...
server: github.com
```

No `access-control-*` header on the redirect response itself. (Per the
Fetch spec, cross-origin redirects don't require CORS headers on the
redirect hop — the check that matters is on the final response — so this by
itself isn't disqualifying.)

(`$LOCATION_FROM_HOP_1` in the next command was captured by piping the Hop 1
response through `grep -i '^location:'` and stripping the prefix — not
pasted as a literal URL in this note because it's a signed Azure Blob URL
with a `se=` expiry param good for roughly 15 minutes from issuance; a
pasted copy would 403 by the time anyone reads this doc.)

### Hop 2: `release-assets.githubusercontent.com` (the actual asset bytes) — **no CORS header**

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" "$LOCATION_FROM_HOP_1"

HTTP/2 200
content-disposition: attachment; filename=AF-F4_T10_nano-v0.3.4.apj
content-type: application/octet-stream
content-length: 798383
server: Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0
via: 1.1 varnish, 1.1 varnish
```

No `access-control-allow-origin` in the response at all. This is a
same-account Azure Blob Storage signed URL, and it doesn't echo CORS
headers for arbitrary origins. **A browser `fetch()` against this URL, in
default `cors` mode, resolves to a network error (`TypeError: Failed to
fetch`) — the response is not readable by JS**, regardless of which repo,
which asset, or which content-type.

### Hop 1+2 repeated for the `.hex` asset (same release, second file)

The `.apj` above is one of two assets on `AF-F4_T10_nano-v0.3.4`; the other
is `AF-F4_T10_nano-v0.3.4_with_bl.hex` (the WebUSB-DFU full-image target).
Ran the identical two-hop check against it rather than assuming the result
carries over from the `.apj`:

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" \
  "https://github.com/novaX-ALUX/flight_controller/releases/download/AF-F4_T10_nano-v0.3.4/AF-F4_T10_nano-v0.3.4_with_bl.hex"

HTTP/2 302
location: https://release-assets.githubusercontent.com/github-production-release-asset/1179426748/...(signed URL)...

$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" "$LOCATION_FROM_HOP_1"

HTTP/2 200
content-disposition: attachment; filename=AF-F4_T10_nano-v0.3.4_with_bl.hex
content-type: application/octet-stream
content-length: 2515648
server: Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0
```

Same result: no `access-control-*` header anywhere. `.apj` and `.hex` — the
two file types this project actually ships — are both confirmed directly,
not inferred from one another.

Also tried the `api.github.com` asset-by-ID redirect path (`GET
/repos/.../releases/assets/{id}` with `Accept: application/octet-stream`)
in case it took a different route — it 302s to the *same*
`release-assets.githubusercontent.com` host with the same missing header:

```
$ curl -sD - -o /dev/null -H "Origin: ..." -H "Accept: application/octet-stream" \
  "https://api.github.com/repos/novaX-ALUX/flight_controller/releases/assets/460274522"

HTTP/2 302
access-control-allow-origin: *      # <- this is api.github.com's own CORS header on the redirect
location: https://release-assets.githubusercontent.com/...
```

The `*` here is `api.github.com` permitting the *redirect response*; the
byte payload at the `Location` target is identical to Hop 2 above and has
no CORS header. There is no path through GitHub's release-asset
infrastructure that avoids this.

### Corroboration on a second, unrelated public repo (`cli/cli`)

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" \
  "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_checksums.txt"
  → 302 → release-assets.githubusercontent.com

$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" "$LOCATION"
HTTP/2 200
(no access-control-* header)
```

Identical behavior. This is infrastructure-level (GitHub's release-asset
CDN never sends CORS headers, for any repo, any visibility, any file type),
not something specific to `novaX-ALUX/flight_controller` or that would
change once the repo has real firmware assets.

### `api.github.com` release metadata — CORS **works**

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" \
  "https://api.github.com/repos/novaX-ALUX/flight_controller/releases/latest"

HTTP/2 200
access-control-allow-origin: *
access-control-expose-headers: ETag, Link, Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, ...
x-ratelimit-limit: 60
x-ratelimit-remaining: 59
x-ratelimit-reset: 1782976762

$ curl -sD - -o /dev/null -X OPTIONS -H "Origin: https://novax-alux.github.io" \
  -H "Access-Control-Request-Method: GET" \
  "https://api.github.com/repos/novaX-ALUX/flight_controller/releases/latest"

HTTP/2 204
access-control-allow-origin: *
access-control-allow-methods: GET, POST, PATCH, PUT, DELETE
access-control-max-age: 86400
```

`api.github.com` sends `Access-Control-Allow-Origin: *` on every response,
including the preflight `OPTIONS`. This is a real, working, directly usable
path for release **metadata** (tag name, asset names, `browser_download_url`
strings, published date, etc.) — just not for asset *bytes*.

### `raw.githubusercontent.com` — CORS **works** (comparison point, not release assets)

```
$ curl -sD - -o /dev/null -H "Origin: https://novax-alux.github.io" \
  "https://raw.githubusercontent.com/novaX-ALUX/flight_controller/main/README.md"

HTTP/2 200
access-control-allow-origin: *
```

Files committed directly to the git tree (served via `raw.githubusercontent.com`
or the Contents API) get CORS; files uploaded as **release assets** (served
via `release-assets.githubusercontent.com`) do not. This is the one lever
that could avoid mirroring into the GC site itself (see recommendation).

### Node `fetch()` corroboration (limitation stated honestly)

```
$ node -e "
fetch('https://github.com/novaX-ALUX/flight_controller/releases/download/AF-F4_T10_nano-v0.3.4/AF-F4_T10_nano-v0.3.4.apj')
  .then(r => console.log('status', r.status, 'redirected', r.redirected,
    'acao', r.headers.get('access-control-allow-origin')))
"
status 200 redirected true acao null
```

Node 18+ `fetch()` followed the redirect and downloaded the file
successfully (`status 200`) — Node does not implement or enforce CORS, so
this **is not** evidence a browser would allow it. It's shown here only to
confirm `access-control-allow-origin` is literally absent (`null`) on the
real response a browser would also receive, which is the actual determining
fact.

## Other considerations from the brief

- **Rate limits.** Unauthenticated `api.github.com` = 60 req/hour/IP
  (confirmed above: `x-ratelimit-limit: 60`). Asset downloads
  (`release-assets.githubusercontent.com`) are **not** API calls and don't
  count against this. 60/hr/IP is fine for a human manually opening the
  firmware page a few times, but is shared per-NAT-IP (office/CI networks)
  and has no user-visible warning until a `403` — a page that calls
  `api.github.com` directly from every visitor's browser is fragile at
  scale. This is a second, independent argument for mirroring (see below):
  mirroring means the *browser* never calls `api.github.com` at all — only
  a CI job does, once per release, with an authenticated token (5000/hr).
- **Private-repo implication (repo is public today, but noting for the
  record since it could change).** If the repo were private,
  `api.github.com` and every asset URL require `Authorization` even to
  read. A static GitHub Pages site has no server to hold a secret — an
  embedded PAT in client JS is public to anyone who opens devtools. Browser-direct
  fetch of a private repo's releases is a non-starter regardless of CORS;
  it would require a backend token-broker (out of scope for a static site).
  Not currently blocking since the repo is public, but worth remembering if
  visibility is ever revisited.
- **`manifest.json` as a release asset — same block as firmware binaries.**
  The design doc (§7 of
  `docs/superpowers/specs/2026-07-02-novax-configurator-design.md`) plans
  to publish `manifest.json` "随 GitHub Release 发布" (as a release asset,
  alongside the `.apj`/`.hex`). That means `manifest.json` would be served
  from `release-assets.githubusercontent.com`, hitting the **exact same**
  missing-CORS-header wall as the firmware binaries — content-type makes no
  difference, verified directly against both the `.apj` and the `.hex`
  assets (see Evidence above), and corroborated infrastructure-level via
  `cli/cli`'s `.txt` asset. **A `manifest.json` release asset cannot be
  `fetch()`-ed by the browser either.**

## Correction to the existing design assumption

`docs/superpowers/specs/2026-07-02-novax-configurator-design.md` §7 says:

> 获取:浏览器直接 fetch GitHub Releases(实现时先验证 CORS 重定向链路;若不
> 可行,回退方案为 manifest 镜像到本站点 public/,**固件文件仍指向
> Releases**)。

That fallback phrasing reads as "if CORS fails, mirror only the manifest;
firmware files can stay pointed at Releases." The evidence above shows that
doesn't hold for the actual use case: §7 also specifies **WebUSB DFU** and
**PX4 serial bootloader** flashing, both of which need the firmware bytes
as an in-memory `ArrayBuffer` in JS to write over USB/serial — a plain
`<a href="...releases/download/...">` browser-native download (which *does*
work, since navigation isn't subject to CORS) only gets the file onto the
user's disk, not into the page's JS. Since `release-assets.githubusercontent.com`
has no CORS for any file, "固件文件仍指向 Releases" as a direct-`fetch()`
target is not viable once you're past the "if CORS fails" branch — and the
verified answer here is that it does fail. **Both `manifest.json` and the
firmware binaries need mirroring**, not just the manifest.

## Recommendation

Mirror both `manifest.json` and the firmware binary assets into the GC
site's own `public/firmware/`, published same-origin via GitHub Pages. This
was already the spec'd fallback for the manifest; extend the identical
mechanism to firmware binaries — it's the same pipeline, not new design
surface, and it happens to also dodge the unauthenticated rate-limit
concern for every site visitor.

**Sync mechanism** (implementation detail for Task 1.1/3.3, not built in
this spike): a small script, run in CI (flight_controller's release
workflow, or a scheduled/webhook-triggered job in GC), using an
authenticated `gh`/API token (server-side — no CORS applies to a non-browser
HTTP client, and 5000 req/hr authenticated has headroom):

1. `gh api repos/novaX-ALUX/flight_controller/releases/latest` (or list, for
   multi-board history) to enumerate assets.
2. Download `manifest.json` + the referenced `.apj`/`.hex` files (asset
   downloads, not API calls — no rate-limit concern here either).
3. Write into GC's `public/firmware/<boardId>/<version>/` and update a
   manifest index the site can look up by board.
4. Commit/PR into the GC repo (or push to a deploy artifact) so Pages serves
   them same-origin.

**`fetchManifest()` contract** (for Task 1.2/3.3 to build against):

```ts
async function fetchManifest(boardId: string): Promise<Manifest> {
  const res = await fetch(`/firmware/${boardId}/manifest.json`)
  if (!res.ok) throw new ManifestFetchError(res.status)
  return res.json()
}

async function fetchFirmwareBytes(url: string): Promise<ArrayBuffer> {
  // url is a same-origin path from manifest.files[].url, e.g.
  // /firmware/AF-F4_T10_nano/v0.3.4/AF-F4_T10_nano-v0.3.4_with_bl.hex
  const res = await fetch(url)
  if (!res.ok) throw new FirmwareFetchError(res.status)
  return res.arrayBuffer()
}
```

Both same-origin, no redirect chain, no CORS surface, no `api.github.com`
call from the browser at all. Error/fallback path: if the mirrored file
404s (sync hasn't run yet for a just-cut release), surface a clear "firmware
temporarily unavailable, check back shortly" — do **not** attempt a
live cross-origin fallback fetch straight to
`github.com/.../releases/download/...` on 404, since that would silently
fail with an undiagnosable `TypeError: Failed to fetch` (CORS errors carry
no distinguishing information in the browser's fetch API, by design, for
security reasons) rather than a clear error.

**Not recommended, but noted as theoretically available**: committing
`manifest.json` (and/or firmware binaries) directly into
`flight_controller`'s git tree instead of/alongside uploading as a release
asset would make them servable via `raw.githubusercontent.com`, which does
send `Access-Control-Allow-Origin: *`, avoiding the mirror pipeline
entirely for the browser side. Rejected for firmware binaries specifically:
committing multi-MB `.hex`/`.apj` blobs directly into git (repeated per
release, per board) bloats repo history in a way GitHub Releases exists
specifically to avoid; would need Git LFS, which reintroduces its own
CORS/auth questions. Could be reconsidered for `manifest.json` alone (it's
small, text, and changes per release) as a lighter alternative to the CI
mirror pipeline — worth a one-line mention in Task 0.4, not a decision made
here.

## Concerns to carry into Task 0.4 (选型锁定记录)

1. **Firmware binary mirroring is now confirmed load-bearing, not optional.**
   The existing design doc's fallback phrasing under-scoped this
   ("固件文件仍指向 Releases") — Task 0.4 should update §7 to reflect that
   both manifest and firmware binaries require the mirror pipeline, given
   WebUSB/serial flashing needs in-memory bytes.
2. **Sync pipeline is new build surface.** A CI job (or manual script run
   per release, at minimum for M1) that pulls from `flight_controller`'s
   releases and writes into GC's `public/firmware/` needs to be designed —
   not just "fetch in the browser" as originally hoped. Freshness/staleness
   (site not yet synced after a new flight_controller release) is a new
   failure mode requiring a clear user-facing message.
3. **GC repo size growth.** Mirrored firmware binaries land in the GC site's
   own git history (or a separate deploy artifact, if kept out of git) —
   worth deciding retention policy (all versions vs. latest N) in Task 0.4
   rather than accreting forever.
4. **Rate limits are moot for the recommended architecture** (browser never
   calls `api.github.com`), but if any *fallback* path considered later
   involves a browser call to `api.github.com` directly, remember
   60 req/hour/IP unauthenticated, shared across everyone behind the same
   NAT/office IP.

## Repo artifacts from this spike

No code changes — this is a header-evidence spike per the task brief
("no real browser available — header-level evidence is acceptable"). Only
this note (`docs/notes/releases-cors-spike.md`) is added. All `curl`/`node`
commands were run directly against the live, public `novaX-ALUX/flight_controller`
repo and `cli/cli` (for corroboration); nothing was cloned or left in
scratch space beyond ephemeral shell state.
