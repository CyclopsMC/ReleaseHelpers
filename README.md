# Release Helpers
Scripts to help automate Cyclops mod releases.

## Setup

Add `bin/` to your `PATH`.
The Node.js scripts (`cc-mark`, `cc-changelog-draft`, `cc-changelog-finalize`, `cc-update-versions`) need Node.js 18 or higher.
`cc-update-versions` also needs `npm install` in `bin/`.

### Config

The helpers read `~/.config/cc-helpers.json` (or the file in `$CC_HELPERS_CONFIG`).
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
  Checkouts not named after their origin repository (e.g. a temporary copy) are skipped.
- `jobs` (optional): how many repos to process in parallel. Default: 8.
- `devOnlyPaths` (optional): extra regexes for files that don't affect players, on top of the built-in ones.

### Shell completion

zsh, in `~/.zshrc`:
```bash
source /path/to/ReleaseHelpers/completions/cc-helpers.zsh
```

bash, in `~/.bash_profile` on macOS (Terminal and iTerm start login shells, which read that file and not `~/.bashrc`), or in `~/.bashrc` elsewhere:
```bash
source /path/to/ReleaseHelpers/completions/cc-helpers.bash
```

## Which commits need a release

The helpers find each mod's unreleased commits per MC version: the commits since its last release on that branch, and the commits on lower maintained branches that still have to be upmerged.
Mods without any release on any version (like the compat mods) are only upmerged.

A filter leaves out commits players won't notice: `Bump mod version` commits, and commits that only touch files players don't get, like CI, tests, game tests, Gradle files and build logic, `*.md` files and changelogs.
`Bump compat version` commits only count when their message lists changelog entries, and translations count but are told apart.

### Commits that need no release

For the commits the filter can't tell apart, e.g. a build change that also touched a source file:

- Put `[no release]` anywhere in the commit message.
  To have Claude do that for you, add this to `~/.claude/CLAUDE.md`:
  `In mod repos, add "[no release]" to the body of commit messages for changes players won't notice, like build, CI or test changes.`
- Or mark the commit afterwards. A mark is for one MC version, as a change may matter on one version and not on another:
  ```bash
  cc-mark no-release 1a2b3c4 --version 26-lts
  ```
  In a mod checkout, it is for that checkout's version unless you say otherwise. `--version` can be given more than once, and `--all-versions` marks it for every version (a mark for one version wins over that).
  `cc-mark release <commit>` does the opposite (a commit that the filter drops, but needs a release), `cc-mark clear <commit>` removes its marks (or only those of `--version`), and `cc-mark list` shows them all.
  Marks are stored in `~/.local/share/cc-helpers/marks.json`, by full commit hash and branch. Upmerges keep hashes, so a mark for 26-lts also applies while the commit is still waiting to be upmerged into 26-lts.

## Changelog drafts

`cc-changelog <patch|minor|major>` starts from a draft made by `cc-changelog-draft`:

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

- Commits upmerged from the branch in `../.upmerge-src-branch` reuse the entries of the source release that contains them.
- Other commits are drafted from their message: `Closes #x`-style lines are folded into the entry, the rest of the body is indented, and the section is picked from the first word (Fix, Remove, ... go to Fixes; Add, Allow, Show, ... to Additions; the rest to Changes).
- `Bump compat version` commits contribute the entries listed in their message, and translation commits become "Add translations through Crowdin".
- Entries that are already in an earlier changelog of the same MC version are left out (e.g. backports).
- `# ...` lines say where each group of entries comes from, and list what was left out and why.

