# Release Helpers
Scripts to help automate Cyclops mod releases.

## Setup

Add `bin/` to your `PATH`.
The Node.js scripts (`cc-status`, `cc-changelog-draft`, `cc-changelog-finalize`, `cc-build`, `cc-release-chain`, `cc-update-versions`) need Node.js 18 or higher.
`cc-update-versions` also needs `npm install` in `bin/`.

### Config

`cc-status` reads `~/.config/cc-helpers.json` (or the file in `$CC_HELPERS_CONFIG`).
Start from [`cc-helpers.example.json`](cc-helpers.example.json):

```json
{
  "versions": [
    { "dir": "~/mc20-lts", "branch": "master-1.20-lts" },
    { "dir": "~/mc21-lts", "branch": "master-1.21-lts" },
    { "dir": "~/mc26-lts", "branch": "master-26-lts" },
    { "dir": "~/mc26", "branch": "master-26" }
  ]
}
```

- `versions`: the maintained MC versions, from lowest to highest.
  Each `dir` holds one git checkout per mod, named after the mod (e.g. `~/mc20-lts/IntegratedDynamics`).
  A version's name is its branch without `master-` (e.g. `1.20-lts`), unless you set `name`.
- `jobs` (optional): how many repos to process in parallel. Default: 8.
- `devOnlyPaths` (optional): extra regexes for files that don't affect players, on top of the built-in ones.

Used by `cc-build` and `cc-release-chain` (all optional):

- `gradleOpts` (per version): Gradle properties for that MC version, passed as `-D` options through `GRADLE_OPTS`.
  These override the same keys in `~/.gradle/gradle.properties`, so you don't have to edit that file per version:
  ```json
  { "dir": "~/mc20-lts", "branch": "master-1.20-lts", "gradleOpts": {
      "org.gradle.java.home": "/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home",
      "org.gradle.jvmargs": "-Xmx4g -XX:+HeapDumpOnOutOfMemoryError --add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED"
  } }
  ```
- `build`: the build command, default `["./gradlew", "build"]`. `false` disables building; `"build": false` on a version disables it for that version only.
- `maxParallelBuilds`: how many builds (and Claude reviews) may run at the same time across release chains. Default: 2.
- `editor`: the editor for changelog drafts; it must wait until the file is closed (e.g. `"code --wait"`). Default: `$VISUAL`, `$EDITOR`, or `vi`.
- `notify`: whether to show a macOS notification when a release chain needs you after a long step. Default: `true`.
- `claude`: the Claude commands, if you want to change them:
  - `upmerge`: for merge conflicts, default `["claude", "upmerge"]`.
  - `review`: for reviewing clean upmerges headless, default `claude -p --permission-mode acceptEdits` with read, edit, `./gradlew` and read-only git tools allowed. The prompt is added as the last argument.
  - `reviewPrompt`: default "Was the upmerge in last commit correct? If not, fix it, but don't git commit it yet."
  - `fix`: for fixing a failing build, default `["claude"]`.

### Shell completion

zsh, in `~/.zshrc`:
```bash
source /path/to/ReleaseHelpers/completions/cc-helpers.zsh
```

bash, in `~/.bashrc`:
```bash
source /path/to/ReleaseHelpers/completions/cc-helpers.bash
```

## cc-status

Shows which mods need a release or upmerge, per maintained MC version:

```text
$ cc-status
                     1.20-lts  1.21-lts  26-lts     26
CommonCapabilities          .         .       2    new
IntegratedDynamics          .         .       .    new
IntegratedScripting         1       1↑1      ↑2  new↑2
IntegratedTerminals         .         .     1↑1  new↑2

To do, by lowest MC version:
1.20-lts: IntegratedScripting
26-lts: CommonCapabilities, IntegratedTerminals
```

- `N`: unreleased commits since the last release on that branch.
- `↑N`: commits on lower maintained branches that this branch doesn't have yet (to upmerge).
- `t`: all of those commits are translations. Such mods are listed under "Only translations".
- `new`: no release on this MC version yet.
- `!`: the local checkout needs attention: wrong branch, uncommitted changes, unpushed commits or a merge in progress.
- `-`: no checkout for this version. `?`: error, see the bottom of the output.

The "To do" list groups mods by the lowest MC version that needs work, which is where a release chain for that mod starts.

Only commits that matter to players are counted:
- `Bump mod version` commits are ignored.
- `Bump compat version` commits count only if their message lists changelog entries.
- Commits that only touch dev files (CI, tests, game tests, Gradle files, `*.md`, changelogs, ...) are ignored.
- Translation commits count, but are marked with `t`.

Options:
- `cc-status IntegratedDynamics EvilCraft`: only these mods.
- `-v`: list the commits behind each cell, the ones the filter dropped (with the reason), and local checkout problems.
- `--no-fetch`: skip fetching and use the current remote-tracking branches (instant, offline).

`cc-status` only fetches `origin`; it never changes working trees or local branches.

## Changelog drafts

`cc-changelog <patch|minor|major>` now starts from a draft made by `cc-changelog-draft`, instead of the raw `git log`:

```text
As always, don't forget to backup your world before updating!
Requires CyclopsCore version 1.31.0 or higher.

# Draft made by cc-changelog-draft: review every entry. Lines starting with # are removed on release.
Additions:
# from 1.21.1-1.39.0
* Add Expressions support to the Logic Programmer (#1766)

Changes:

Fixes:
# from 1.21.1-1.39.0
* Fix non-ticking parts not re-attaching to network after chunk reloads (#1786), Closes #1785
# only on master-26-lts
* Fix labels not being saved in singleplayer (#1784)

# Left out:
#   39a62925b Make battery-related game tests more robust (only dev files)
```

- Commits upmerged from the branch in `../.upmerge-src-branch` reuse the entries of the source release that contains them, so your edits there (rewording, merged entries, extra details) carry over. Entries you removed there stay removed.
- Other commits are drafted from their message: `Closes #x`-style lines are folded into the entry, the rest of the body is indented, and the section is picked from the first word (Fix, Remove, ... go to Fixes; Add, Allow, Show, ... to Additions; the rest to Changes).
- `Bump compat version` commits contribute the entries listed in their message, and translation commits become "Add translations through Crowdin".
- Entries that are already in an earlier changelog of the same MC version are left out (e.g. backports).
- `# ...` lines say where each group of entries comes from, and list what was left out and why.

`cc-changelog-draft` prints the draft for the current checkout (`--since <tag>`, `--source <branch|none>`, `--no-comments`).

`cc-changelog-confirm` (run by `cc-release`) now first runs `cc-changelog-finalize`, which removes the `#` lines and empty sections, and stops the release if the changelog still has a `TODO` marker, a `Bump ... version` entry, merge conflict markers, or no entries.

## cc-build

Builds the mod checkout in the current dir with the `gradleOpts` of its MC version.
Extra arguments are added to the build command, e.g. `cc-build -x test`.

To use the same settings for your own Gradle commands in a terminal:
```bash
eval "$(cc-build --env)"
```

## cc-release-chain

Releases a mod on an MC version and all higher maintained ones:

```bash
cc-release-chain IntegratedDynamics
```
```bash
cc-release-chain IntegratedTerminals 1.21-lts
```

Without a version, it starts at the lowest version with unreleased changes (as in `cc-status`).
It first shows the chain and asks to start, then does this for each version, in order:

1. **Sync**: checks the branch, fetches, and fast-forwards. Unpushed local commits are only released after you confirm.
2. **Upmerge** from the version below (`cc-upmerge`). On conflicts, it starts `claude upmerge`; exit Claude when it's done.
3. **Build** with the version's `gradleOpts`, logging to `.git/cc-release-chain/build.log`.
   If it fails, it shows the end of the log and lets you retry, ask Claude to fix it, skip the build, or abort.
4. **Review**: after a clean upmerge, Claude reviews it headless. If Claude changed files, you see the diff and choose to commit them (then it builds again) or revert them.
5. **Changelog**: drafts it with `cc-changelog-draft` and opens it in your editor. When you close the editor, it is finalized like `cc-changelog-finalize` does; if that fails you can edit again, skip this version's release, or abort.
6. **Bump**: you choose patch, minor or major for this version. The suggestion is minor when the changelog has Additions, else patch; what the version below got is shown, but never used as the default.
7. **Dependencies**: warns if a mod this one depends on (a `<modid>_version` property) has unreleased changes or a running release chain on the same MC version.
8. **Release** with `cc-release`.

Options:
- `--confirm`: ask before pushing each release, showing the tag, the commits to push, the build and review results, and the changelog. Useful while you get used to the chain; leave it out once you trust it.
- `--rehearse`: a dry run with the real tools, see below.
- `--no-review`, `--no-build`: skip the Claude review or the build.

Versions without a release on their MC version yet (e.g. a new MC version) only get the upmerge pushed, and so do versions where nothing user-facing changed. At the end, it prints a summary per version.

You can stop at any prompt (or with Ctrl-C) and run the same command again to continue: the upmerge, a passed build, a review and your edited draft are kept.

### Rehearsals

```bash
cc-release-chain --rehearse IntegratedDynamics
```

Runs the whole chain for real (Gradle, Claude, your editor, signing, upmerges and the release commits) on copies of your checkouts, whose `origin` is a local stand-in for the real one. Nothing is pushed to the real origin, so nothing gets published, and your checkouts are not changed (they only fetch).

- The stand-in origin starts with the state each checkout just fetched; the copies start at your local branches, including unpushed commits, but without uncommitted changes.
- Local git settings for merging and signing, and small ignored files like `secrets.properties`, are copied along. Submodules (like CommonCapabilitiesAPI) are set up from your checkouts, or else from their URLs.
- At the end it shows what would have been pushed: the commits per branch and the new tags with their changelogs.
- The copies are kept under `~/.cache/cc-helpers/rehearsals/` for inspection. They share git objects with your checkouts (so they are quick to make), but their builds take space: delete them when done.
- The first build in a copy is a cold one (no `build/` dir yet), so it takes longer than usual.
- A rehearsal can't be continued after stopping; run it again to start a new one.

### Running chains in parallel

You can run chains for different mods at the same time, each in its own terminal:

- Each chain only touches its own mod's checkouts. A second chain for the same mod is refused.
- Builds use `GRADLE_OPTS` per process, so nothing shared like `~/.gradle/gradle.properties` is changed.
- At most `maxParallelBuilds` builds and reviews run at once; other chains wait for a slot. Rehearsals share these slots.
- After a long step, a chain rings the terminal bell and shows a macOS notification when it needs you.
- If mod B depends on mod A, release A first: step 7 warns when A still has unreleased changes or a running chain.

## Tests

```bash
node --test test/*.test.js
```

On macOS, the tests need GNU sed as `gsed` (`brew install gnu-sed`), like `cc-bump`.

`test/real/` replays past release rounds of real mods (cloned from GitHub, so it needs network access).
Each mod starts at the commits just before a round, and `cc-release-chain --rehearse` makes the same
releases again, with stand-ins for Gradle, Claude and GPG, and an editor stand-in that saves each draft
and replaces it with the changelog that was really published. The test checks the new tags, versions,
changelogs, upmerges and submodules, and compares the drafts and the `cc-status` output with snapshots
in `test/real/snapshots/`:

```bash
node --test test/real/*.test.js
```

After an intended change to drafts or `cc-status`, update the snapshots and review their diff:

```bash
UPDATE_SNAPSHOTS=1 node --test test/real/*.test.js
```

Set `CC_REAL_REPOS_DIR` to keep the clones between runs.
