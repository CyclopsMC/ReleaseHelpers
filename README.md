# Release Helpers
Scripts to help automate Cyclops mod releases.

## Setup

Add `bin/` to your `PATH`.
The Node.js scripts (`cc-status`, `cc-update-versions`) need Node.js 18 or higher.
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

Options:
- `cc-status IntegratedDynamics EvilCraft`: only these mods.
- `-v`: list the commits behind each cell, the ones the filter dropped (with the reason), and local checkout problems.
- `--no-fetch`: skip fetching and use the current remote-tracking branches (instant, offline).
