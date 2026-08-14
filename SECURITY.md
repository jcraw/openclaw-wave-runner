# Security

## Reporting

Please open a **private** GitHub security advisory on this repository, or email the maintainer via GitHub profile contact, for vulnerabilities that could:

- bypass budget / lease / cancel gates  
- cause unintended production worker launches  
- leak credentials from worker env or artifacts  

## Operational notes

- Wave Runner can spawn coding agents with repo write access when supervised mode is enabled and adapters are wired.  
- Defaults refuse unrestricted drain, overnight autonomy, and deploy/push.  
- Run against disposable Gateway profiles when validating.  
- Do not commit API keys, OpenClaw gateway tokens, or private ticket corpora into this repo.  
