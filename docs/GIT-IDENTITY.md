# Git identity

GitHub maps `NAME@users.noreply.github.com` to the **GitHub login** `NAME`, not to the author display name.

Wrong (this attached [github.com/jason](https://github.com/jason), a stranger):

```
Jason Craw <jason@users.noreply.github.com>
```

Also wrong: any personal mailbox (`gmail.com` or otherwise) as `user.email` / commit author. That address becomes public git metadata.

Right for this repo:

```
JCraw <4335668+jcraw@users.noreply.github.com>
JCraw <jcraw@users.noreply.github.com>
```

Before the first commit on a **new** `jcraw/*` repo, set identity from `gh api user`:

```bash
git config user.name "JCraw"
git config user.email "4335668+jcraw@users.noreply.github.com"
```

Never invent `{firstname}@users.noreply.github.com`.
Never commit with a personal inbox.

`npm run quality` runs `scripts/check-git-identity.mjs` so a bad noreply or a personal mailbox in local `user.email` fails CI.
