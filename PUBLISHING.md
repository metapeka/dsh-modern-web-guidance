# Publishing this plugin

Two independent channels. Neither replaces the other, and the order matters: the GitHub
repo has to exist before either one can point at it.

| Channel | What it gets you | Effort |
|---|---|---|
| **GitHub repo + awesome-dsh-plugin PR** | Listed on the curated list and in every storefront that reads it (`dsh-market`, plugin markets) | one YAML file, one PR |
| **npm package** | Auto-indexed by `REALOIYO/dsh-plugin-market` (rebuilds daily from npm) and shown with a download count on the curated list | `npm publish` |

`dsh-modern-web-guidance` already satisfies every structural requirement the catalog's CI
checks. What is missing is the repo itself.

> **Status: the repo is public.** `github.com/metapeka/dsh-modern-web-guidance` was pushed as a
> private repository, audited, and then flipped on 2026-11-08 — both channels below require a public
> one, because the catalog fetches `package.json` from it and npm cannot link a package to a repo
> nobody can see. Verified anonymously: the repo page, `package.json`, the audit reports and the
> marketplace icon (`raw.githubusercontent.com/…/main/icon.png`, `image/png`, 114 544 B) all return
> 200 without credentials.
>
> What remains before the PR: the repo must be **at least one day old** — created 2026-11-08
> 01:55 UTC, so the gate opens 2026-11-09 01:55 UTC. The `dsh-plugin` and `dsh` topics are set.
> Before the flip, history was scanned for credentials: none, and the one planted-secret fixture the
> security repro used is no longer tracked (see the "Untrack the repro's runtime fixtures" commit).

## 0. Pre-flight (already done in this tree)

- [x] `package.json` declares `dsh.bundle.patch` — this is what makes the package installable
      via `dsh plugin add`. Declaring only `dsh.client` is the most common reason submissions
      are rejected; this package declares neither `dsh.client` (it ships no browser UI) nor any
      other half-manifest.
- [x] `cordis.patch.yml` sits next to `package.json` and inserts `modern-web-guidance` →
      `dsh-modern-web-guidance`.
- [x] Real working code: 3 tools, 2 skills, 193 guides, 66 tests (`npm test`, which runs
      `node --test test/*.test.mjs`; a single file also runs directly where child processes are blocked).
- [x] The tests workflow is green on `main`: `.github/workflows/test.yml` runs `npm test` plus
      `npm pack --dry-run` on every push and PR, so it guards both the suite and the package contents.
- [x] 0.2.0 adds local usage counters and the human `/guidance-stats` command: counts are written to the
      profile's durable storage, nothing leaves the machine, and the plugin still makes no network calls.
      The published tarball gains no dev files — the counters are runtime state, not package content.
- [x] `license: Apache-2.0`, `LICENSE` + `NOTICE` with upstream attribution.
- [x] No `@deepseek-ai/*` dependencies at all — nothing to move into `peerDependencies`, and no
      prerelease peer range that could silently exclude harness `-rc` builds.
- [x] Installed and verified live in the `desktop` profile: both skills appear in the skill
      catalog, all three tools are listed by `Tool.listTools`, `web_guidance_search` and
      `web_guidance_retrieve` return real guide content. 0.2.0's `/guidance-stats` is registered by
      the host command registry (it shows up in the slash menu with its description) and its handler
      runs on a live instance: `--reset --yes` wrote the version-1 counters document to
      `<profile>/storage/modern-web-guidance/stats.json`.
- [x] 0.3.0's panel verified live in a throwaway Web instance: the rail entry appears with its localized
      label, the central panel opens, and Refresh rendered counters recorded by a real agent turn
      (2 calls, 100% hit rate, full 17-category coverage table, 192 of 193 guides never retrieved).

## 1. Create the GitHub repo (done — created private, later flipped to public)

The `repository`, `bugs` and `homepage` fields in `package.json` point at
`github.com/metapeka/dsh-modern-web-guidance`, so the repo had to exist under that exact name —
otherwise npm and the curated list cannot link the package back to the repo. It now does:

```sh
# what was already run
git init -b main
git add -A && git commit -m "dsh-modern-web-guidance 0.1.0"
gh repo create metapeka/dsh-modern-web-guidance --private --source . --push \
  --description "Google Chrome's Modern Web Guidance for DeepSeek Harness: offline guide search, retrieve and list tools plus the modern-web-guidance and chrome-extensions skills."
gh repo edit metapeka/dsh-modern-web-guidance --add-topic dsh-plugin --add-topic dsh
```

Two repo-level requirements from the catalog, both satisfied once the repo is public:

- the **`dsh-plugin` topic** — required, checked by hand (already set);
- the repo must be **at least one day old** when the PR is opened. CI checks this
  automatically; if you submit earlier the gate says "0.x days old" and simply passes by
  itself a few hours later, without a push. Nothing is held against a resubmission. The clock
  started when the repo was created, so a private repo left parked for a day arrives at the PR
  with the age requirement already met.

## 2. Submit to awesome-dsh-plugin

The list lives in `data/plugins/`, one YAML file per plugin. Copy the prepared entry:

```sh
gh repo clone awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
git switch -c add-dsh-modern-web-guidance
cp <this-repo>/market/awesome-dsh-plugin.yml \
   data/plugins/metapeka__dsh-modern-web-guidance.yml
git add data/plugins/metapeka__dsh-modern-web-guidance.yml
git commit -m "Add metapeka/dsh-modern-web-guidance"
git push -u origin add-dsh-modern-web-guidance
gh pr create --title "Add metapeka/dsh-modern-web-guidance" \
  --body "Adds dsh-modern-web-guidance: 3 tools and 2 skills over Google Chrome's 193-guide Modern Web Guidance catalog, all offline."
```

Rules that apply to this submission, from the catalog's `contributing.md`:

- **One file, at most 3 entries per PR.** Generated `README.md` / `README.zh.md` must not be
  edited by hand — they are regenerated on `main` after merge.
- **`description.en` is the only required field.** `zh` is optional; a maintainer fills it in.
  A description containing `": "` must be quoted, which the prepared file already does.
- **The description is checked against the code.** "three tools", "193 guides", the two skill
  names and the `modern-web-guidance` / `chrome-extensions` pair all exist as claimed. Do not
  add adjectives to it later — overstating is the one thing that gets a good plugin sent back.
- **Category is `skill`.** The taxonomy is `agi ui usage theme model identity session memory
  tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`.
  This package is not document rendering (`docs`) and not browser control (`browser`); it ships
  two skills and three tools. A near miss is re-filed by a maintainer rather than bounced.
- **`icon:` must be a GitHub-hosted raster image** (`png`/`jpg`/`jpeg`/`webp`) — SVG is refused,
  and the field is optional. This repo ships both: `icon.svg` for the plugin surface (`package.json`
  `icon`) and `icon.png`, its 512×512 rasterisation, for the marketplace. `market/…yml` points
  `icon:` at the raw GitHub URL of the PNG; keep the file path stable, since the URL breaks if the
  file moves or the branch is renamed, and it stays a 404 until the repo is public. Regenerate
  from the repo root with headless Chrome (a fresh `--user-data-dir` each time: a stale profile
  lock makes Chrome exit silently without writing the file):

  ```shell
  chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size=512,512 \
    --user-data-dir="$(mktemp -d)" --screenshot="$PWD/icon.png" "$PWD/market/icon-512.html"
  ```

  where `market/icon-512.html` renders `icon.svg` at exactly 512×512 on a transparent background,
  so the SVG's rounded corners stay transparent in the PNG.
- **Screenshots are optional and declared in *this* repo**, not in the PR: a `screenshots.json`
  next to `package.json` listing 1–8 repo-relative image paths. Absolute URLs are accepted only
  on GitHub hosting.
- **CI checks**, in order: entry count → `dsh.bundle` in `package.json` → repo age →
  `awesome-lint` and the site build. A red "READMEs match data/plugins" step on a stale branch
  is the maintainer's to regenerate; do not fix it by hand.
- **Etiquette:** if a maintainer adds the `held: author` label, push fixes to the same branch and
  leave exactly one comment describing them. The label never clears automatically.

## 3. Optional: publish to npm

Publishing is **not** required for listing — it only adds a download count and unlocks prebuilt
installs (which skip the `allowBuilds` build-approval prompt).

```sh
npm publish            # or: npm publish --registry=https://registry.npmjs.org
```

Constraints worth knowing:

- **The publication gate is `package.json` `files`, not the git branch.** `AGENTS.md`, `docs/`,
  `audit/`, `test/`, `market/` and this file are dev-only: they live on `main` so agents and the
  skills can read them, and they never enter the tarball. Do not move them to a branch to keep
  the package clean — verify with `npm pack --dry-run`, which lists exactly what ships.
- The published `repository` field must point back at the repo listed in the entry. Ours does.
- Do not add an `npm:` key to the entry — the mapping is picked up from the registry, and a
  hand-written one is rejected by the validator.
- `package.json` `files` ships the runtime (`index.js`, `client.js`, `lib/`, `data/`, `locale/`) plus the three READMEs,
  `LICENSE`, `NOTICE` and the icons — the guides are the payload by a wide margin. The upstream CLI, the
  TFJS model and upstream's Clearcut telemetry are deliberately not included; neither are `docs/`,
  `audit/`, `test/`, `market/`, `AGENTS.md` or this file. 0.2.0 adds no dev files (its usage counters are
  runtime state in the profile, not package content), and 0.3.0 adds one hand-written `client.js` with no
  build step. `npm pack --dry-run` lists exactly what ships:
  238 files, 699 KB packed / 1.9 MB unpacked at 0.3.0.
- **This machine cannot reach `registry.npmjs.org`** (ECONNRESET; the upstream tarball had to come
  from `registry.npmmirror.com`). Publish from a network that can, or let a CI workflow do it.

### Prebuilt tarball instead of npm

If publishing to npm stays unavailable, attach a `.tgz` to a GitHub Release and point the entry
at it. The URL must be `https` and hosted by GitHub Releases itself:

```yaml
# version-free asset name: survives every future release
tarball: https://github.com/metapeka/dsh-modern-web-guidance/releases/latest/download/dsh-modern-web-guidance.tgz
```

`latest/download/` resolves the release at request time but takes the filename literally, so a
versioned asset name 404s after the next release. Attach with a stable name:

```sh
npm pack --pack-destination dist
gh release create v0.1.0 dist/dsh-modern-web-guidance-0.1.0.tgz \
  --title "0.1.0" --notes "First release."
# then re-upload under the stable name, or create the release with that name from the start
```

## 4. Keeping the corpus current

The guides are a snapshot of upstream `modern-web-guidance@0.0.197` (corpus version
`2026_10_30-58d055df`, `chrome-extensions` skill `2026_08_06-8570fe7c`). When upstream ships new
guides, re-run the data refresh described in [README.md](README.md#updating-the-corpus), bump the
minor version, and note the upstream version in the release. The catalog has no mechanism to
refresh a third-party entry automatically — stale snapshots are removed only if the repo goes
dormant.
