# Git identity

GitHub maps `NAME@users.noreply.github.com` to the **GitHub login** `NAME`, not to the author display name.

Wrong (this attached [github.com/jason](https://github.com/jason), a stranger):

```
Jason Craw <jason@users.noreply.github.com>
```

Right for this repo:

```
JCraw <4335668+jcraw@users.noreply.github.com>
JCraw <4335668+jcraw@users.noreply.github.com>
JCraw <jcraw@users.noreply.github.com>
```

Before the first commit on a **new** `jcraw/*` repo, set identity from `gh api user`:

```bash
git config user.name "JCraw"
git config user.email "4335668+jcraw@users.noreply.github.com"
# or the Gmail already on the jcraw account:
git config user.email "4335668+jcraw@users.noreply.github.com"
```

Never invent `{firstname}@users.noreply.github.com`.

`npm run quality` runs `scripts/check-git-identity.mjs` so a bad noreply fails CI.
