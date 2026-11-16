# Release Helpers
Scripts to help automate Cyclops mod releases.

## Setup

Add `bin/` to your `PATH`.
The Node.js scripts (`cc-status`, `cc-changelog-draft`, `cc-changelog-finalize`, `cc-update-versions`) need Node.js 18 or higher.
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
  Checkouts not named after their origin repository (e.g. a temporary copy) are skipped.
- `jobs` (optional): how many repos to process in parallel. Default: 8.
- `devOnlyPaths` (optional): extra regexes for files that don't affect players, on top of the built-in ones.
- `ignoreCommits` (optional): hashes (or prefixes of at least 7 characters) of commits that don't need a release,
  for the cases the file filter can't tell, e.g. a build change that also touched a source file.
  As upmerges keep commit hashes, one entry covers all MC versions.

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
- Mods without any release on any version (like the compat mods) are only upmerged: their cells only show `↑N`, and they are listed under "Upmerge only".

The "To do" list groups mods by the lowest MC version that needs work, which is where a release chain for that mod starts.

Options:
- `cc-status IntegratedDynamics EvilCraft`: only these mods.
- `-v`: list the commits behind each cell, the ones the filter dropped (with the reason), and local checkout problems.
- `--no-fetch`: skip fetching and use the current remote-tracking branches (instant, offline).

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

