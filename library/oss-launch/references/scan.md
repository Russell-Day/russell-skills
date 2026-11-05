# scan.md: how to scan a repo before generating

Goal: know the stack, what already exists, the git identity, and whether anything unsafe
would leak, before writing a single file.

## Stack detection
| Marker file | Stack | Test / build / lint hints |
|-------------|-------|---------------------------|
| `package.json` | Node / JS / TS | `npm test`, `npm run build`, `npm run lint`; read `scripts` |
| `pyproject.toml` / `setup.py` | Python | `pytest`, `ruff`/`flake8`, `python -m build` |
| `Cargo.toml` | Rust | `cargo test`, `cargo build`, `cargo clippy` |
| `go.mod` | Go | `go test ./...`, `go build ./...`, `go vet` |
| `composer.json` | PHP | `composer test`, `composer lint` |
| `*.csproj` / `*.sln` | .NET | `dotnet test`, `dotnet build` |
| `Gemfile` | Ruby | `bundle exec rspec`, `bundle exec rubocop` |
| `build.sbt` | Scala | `sbt test`, `sbt compile` |
| `build.gradle.kts` / `build.gradle` declaring a kotlin plugin, or `.kt` sources | Kotlin | `./gradlew build`, `./gradlew test` |
| `pom.xml` (Maven) / `build.gradle` or `build.gradle.kts` (Gradle) | Java | `mvn verify`, `./gradlew build` |
| `Package.swift` | Swift | `swift build`, `swift test` |
| none of the above | docs / data / skill | no build; lint markdown only |

Order matters in two places. **Scala is tested before Java**, because an sbt project can
also carry a `build.gradle` for tooling while `build.sbt` is unambiguous about what
actually builds it. **Kotlin is tested before Java but only on positive evidence** (a
`kotlin(...)` / `org.jetbrains.kotlin` plugin declaration in the Gradle script, or real
`.kt` sources within 5 levels, excluding `build/`), so a plain Gradle-Java repo still
resolves to `java` rather than being claimed by the earlier branch.

Each stack maps to a `templates/gitignore/<stack>.gitignore` and a
`templates/.github/workflows/<stack>-ci.yml` (Java's single template detects Maven vs
Gradle at runtime, since a repo has one or the other, not both). Rust and Go are the two
exceptions: they have a `.gitignore` but no dedicated CI template yet, and fall back to
`generic-ci.yml`.

Read the manifest: name, version, `license` field, declared scripts. These pre-fill
`{{REPO}}`, `{{LICENSE}}`, `{{STACK}}`, and the CI commands.

## Orthogonal detection

A repo has exactly one primary language stack, but it can simultaneously be a monorepo
and/or containerised. These are separate axes, not more stack branches: a pnpm workspace
is still `node`, it just needs different setup guidance. Both are reported by `apply.sh`
as notes; neither changes which templates get written.

| Marker | Function | Result |
|--------|----------|--------|
| `pnpm-workspace.yaml` / `.yml` | `detect_monorepo` | `pnpm` |
| `"workspaces"` key in `package.json` | `detect_monorepo` | `yarn` when `yarn.lock` is present, else `npm` |
| `[workspace]` table in `Cargo.toml` | `detect_monorepo` | `cargo` |
| more than one `go.mod` within 3 levels | `detect_monorepo` | `go` |
| `Dockerfile`, `docker-compose.yml`/`.yaml`, `compose.yaml`/`.yml` | `detect_docker` | `true` |

A workspace means the generated install/test commands target the repo root and probably
need a package filter, and that `dependabot.yml` should gain per-package `directory:`
entries. Docker means the stack CI template does not build the image, and a container-build
job plus a `docker` dependabot ecosystem are worth adding.

## Existing-file inventory
Check presence (this is what `scripts/audit.sh` automates):
`README.md`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
`CHANGELOG.md`, `.gitignore`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`
(or lowercase), `.github/dependabot.yml`, `.github/workflows/*`.

For an existing README, note which sections are already present so you augment instead of
overwrite (see `generate.md`).

## Git identity
```bash
git -C <repo> remote -v              # origin URL -> {{OWNER}}/{{REPO}}
git -C <repo> rev-parse --abbrev-ref HEAD   # default branch
gh repo view --json visibility,nameWithOwner 2>/dev/null   # public/private + slug
```
No remote yet => ask for the intended `owner/repo`, or leave badge placeholders.

## Secret + brand-leak scan (every run)
Run `python3 scripts/publish-check.py <repo>` (see `publish-check.md`). It replaces the
old quick greps: those only saw today's files, skipped `.md`, and missed history,
commit messages, author emails and the user's personal details.
