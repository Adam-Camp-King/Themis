# Releasing Themis

Two registries, one version. Bump every `packages/*/package.json` and
`python/pyproject.toml` together; the conformance vectors are the contract
between them, so a release that passes CI is a release of both.

## Pre-flight (anyone)

```bash
npm ci && npm run release:check          # typecheck + 215 tests + build + pack dry-run
cd python && pip install build && python -m build --outdir dist && cd ..
```

## npm — `themis-policy-*` (needs the `themis` org on npm)

1. `npm login` (the account must own the `@themis` scope; if the scope is not
   yet claimed, create the org at npmjs.com/org/create with the name `themis`).
2. `npm run release:publish` — publishes `themis-policy` first, then the five
   packages that depend on it, all with `--access public` (scoped packages
   default to private).
3. Verify: `npm view themis-policy version` → `0.1.0`.

## PyPI — `themis-policy`

PyPI is the Python Package Index — Python's npm. Publishing there is what
makes `pip install themis-policy` work. (`themis` and `themis-core` are
already taken by unrelated projects, hence the name.)

Publishing is credential-free: PyPI trusts this repo's
`.github/workflows/publish-pypi.yml` (Trusted Publisher / OIDC, environment
`pypi`). No token exists anywhere.

1. Bump `python/pyproject.toml` version with the npm packages.
2. Push a `v*` tag, or run `gh workflow run publish-pypi.yml -R Adam-Camp-King/Themis`.
3. Verify: `pip install themis-policy==<version>` in a fresh venv.

## After both are live

- `solid-backend`: replace `vendor/themis_policy-0.1.0-py3-none-any.whl` with
  `themis-policy==0.1.0` in `requirements.txt` **only once the base image can
  be rebuilt off the CI runner** (see `solid-backend/vendor/README.md`).
- Tag the repo: `git tag v0.1.0 && git push --tags`.
