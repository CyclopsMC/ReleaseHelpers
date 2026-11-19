# Release Helpers
Scripts to help automate Cyclops mod releases.

## Setup

Add `bin/` to your `PATH`.
The Node.js scripts (`cc-status`, `cc-mark`, `cc-update-versions`) need Node.js 18 or higher.
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
- `github` (optional): `false` to always fetch every checkout, instead of first asking GitHub what changed.

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
- `--fetch-all`: fetch every checkout, without asking GitHub what changed first.

With a GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or the one of the [GitHub CLI](https://cli.github.com/), `gh auth login`), `cc-status` first asks GitHub for the branches and recent tags of all mods in one request, and only fetches the checkouts where something changed.
Without a token, it fetches every checkout.

### Commits that need no release

The filter drops commits that only touch files players don't get, like build files and tests.
For the commits it can't tell apart, e.g. a build change that also touched a source file:

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

`cc-status -v` shows which commits were dropped and why, including your marks.
