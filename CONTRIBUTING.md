# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review, test, lint, and CI pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.
See [`.no-mistakes.yaml`](.no-mistakes.yaml) for this repository's gate agent.

When triggered for a PR targeting `main`, the GitHub Actions check named `PR must be raised via no-mistakes` enforces only head branches starting with `fm/` (the maintainer's agent branch prefix, matched case-insensitively and including forks); every other head branch skips the job, which satisfies the required status check.
When enforced, it fails if the body is missing the deterministic signature that no-mistakes writes, or if the structured pipeline attestation does not show `review`, `test`, and `document` as completed; known automation accounts remain exempt so dependency and release automation can keep working.

## Workflow

Fork routing requires `no-mistakes` v1.30.1 or newer.
This repository's required check also needs `no-mistakes` >= 1.46.0 so the PR body includes structured pipeline step attestation.

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:shin315/menu-sprout.git`).
2. Create a branch and make your changes.
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/menu-sprout.git`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`: `git push no-mistakes`.
6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this repo for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Use `pnpm` with the pinned version from `packageManager`.
- Tests live in `tests/` at the repo root.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before pushing.
- Run `pnpm generate:contracts` and commit `extensions/menusprout-env.d.ts` after changing extension-facing types or `src/shared/extension-contract-names.ts`.
- Run `pnpm package:mac` when changing packaging, runtime paths, extension compilation, native dependencies, or release behavior.
- Local `pnpm package:mac` builds intentionally produce `Menu Sprout Dev.app` with bundle id `io.github.shin315.menusprout.dev`; release automation uses `electron-builder.yml` directly for the production `Menu Sprout.app` identity.
- Follow the universal native-dependency, build-only esbuild exclusion, and packaged runtime verification constraints in [`docs/development.md`](docs/development.md#packaging).
- Keep `pnpm-lock.yaml` changes with dependency changes.
- Do not commit generated build output, release artifacts, runtime caches, or dev extension workspaces.
- Do not hand-edit release-please metadata such as `CHANGELOG.md` or `.release-please-manifest.json`.
- See `AGENTS.md` for architecture notes, extension workspace rules, and agent-specific constraints.

## Release Notes

Menu Sprout has not published a release yet, and the `release-please` workflow stays inert until the maintainer sets the `MENU_SPROUT_RELEASES_ENABLED` repository variable to `true`.
Once enabled, releases are proposed by release-please after conventional commits land on `main`.
Use prefixes such as `feat:` and `fix:` so release-please can choose the version bump and release notes.
Mark breaking changes with `!` in the commit type or a `BREAKING CHANGE:` footer.
Merging the release-please PR creates the version tag and a draft GitHub Release.
The release-please workflow builds the universal macOS app, signs every code object with the configured `Developer ID Application: <APPLE_DEVELOPER_ID_NAME> (<APPLE_TEAM_ID>)` identity, notarizes and staples the app and DMG, verifies the publication-ready DMG, computes its checksum, uploads it to the draft, and only then publishes the release.
Any signing, notarization, verification, packaged runtime, checksum, or GitHub upload failure leaves the release as a draft and stops before stable publication.
There is no Homebrew cask; the GitHub release is the only distribution channel.

Before enabling releases, maintainers must provision these repository variables:

- `APPLE_TEAM_ID` - the Apple Developer Team ID that owns the signing certificate.
- `APPLE_DEVELOPER_ID_NAME` - the name in the certificate's `Developer ID Application: <name> (<team id>)` common name.
- `MENU_SPROUT_UMAMI_HOST` and `MENU_SPROUT_UMAMI_WEBSITE_ID` - optional; packaged-release telemetry stays off unless both are set. They are variables rather than secrets because they are baked into the app and sent in Umami payloads.

And these repository secrets, from the canonical secure owners:

- `MAC_DEVELOPER_ID_CERT_P12` - base64 of the password-protected Developer ID Application certificate and private key for `APPLE_TEAM_ID`.
- `MAC_DEVELOPER_ID_CERT_PASSWORD` - the p12 export password.
- `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_API_KEY` - the App Store Connect API credentials used by `notarytool`; the API key is base64-encoded p8 content.

Never commit or print credential contents. Missing or malformed variables or secrets fail the real release job; pull-request CI remains secret-free and validates the release config through `tests/release-config.test.ts`.

To release, merge the release-please PR and require the `release-please` workflow's macOS job to pass. The release remains a draft until the signed artifact passes verification and runtime E2E, receives a valid checksum, and uploads successfully. Do not upload a replacement DMG by hand.
For a post-release check of exactly the downloaded artifact on macOS:

```sh
VERSION=x.y.z # Replace with the released version.
TEAM_ID=XXXXXXXXXX # Replace with APPLE_TEAM_ID.
DEVELOPER_ID_NAME="Your Name" # Replace with APPLE_DEVELOPER_ID_NAME.
TAG="menu-sprout-v${VERSION}"
mkdir -p verify-menu-sprout/mount

gh release download "$TAG" --pattern "Menu-Sprout-${VERSION}-universal.dmg" --dir verify-menu-sprout
DMG="$PWD/verify-menu-sprout/Menu-Sprout-${VERSION}-universal.dmg"
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$PWD/verify-menu-sprout/mount"
trap 'hdiutil detach "$PWD/verify-menu-sprout/mount" >/dev/null' EXIT
APP="$PWD/verify-menu-sprout/mount/Menu Sprout.app"

test "$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" = \
  "io.github.shin315.menusprout"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")" = \
  "$VERSION"
codesign --verify --deep --strict --verbose=4 "$APP"
SIGNATURE="$(codesign -d --verbose=4 "$APP" 2>&1)"
grep -Fq 'Identifier=io.github.shin315.menusprout' <<<"$SIGNATURE"
grep -Fq "TeamIdentifier=$TEAM_ID" <<<"$SIGNATURE"
grep -Fq "Authority=Developer ID Application: $DEVELOPER_ID_NAME ($TEAM_ID)" <<<"$SIGNATURE"
grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$SIGNATURE"
grep -Eq '^Timestamp=.+$' <<<"$SIGNATURE"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
lipo "$APP/Contents/MacOS/Menu Sprout" -verify_arch arm64 x86_64

hdiutil detach "$PWD/verify-menu-sprout/mount"
trap - EXIT
```

The expected Gatekeeper result is `accepted` with source `Notarized Developer ID`. The workflow runs these checks, plus per-bundle and per-Mach-O identity, hardened-runtime, and timestamp checks, against the mounted publication-ready DMG before upload.

## Questions

Open an issue if something is unclear.
