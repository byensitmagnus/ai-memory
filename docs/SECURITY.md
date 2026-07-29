# Security and privacy

`ai-memory` is safe to audit because it has no dependencies, telemetry or
network calls. That does **not** make the content you put into a memory system
safe to publish.

## Public repository: allowlist only

Only commit reusable, non-sensitive material here:

- generic scripts and tests;
- neutral templates and documentation;
- links to original third-party projects and their licences.

Never commit any of these:

- API keys, cookies, access tokens, `.env` files or credential notes;
- customer data, live exports, invoices or private URLs;
- full raw chats, session logs or screenshots containing operational data;
- personal `MEMORY.md`, `CONTEXT.md`, project notes or machine paths;
- a third-party skill just because it exists in your local skills folder.

## Private Brain: least surprise

Your private vault may contain real working context, but still keep secrets out
of notes where possible. Store credentials in the platform's intended secret
store or a local ignored `.env` file and write only a neutral pointer in the
vault, such as “credentials are in the deployment secret store”.

Before sharing a private repository with a teammate, use an allowlist review:

1. Check tracked files, not only `.gitignore`.
2. Search the staged diff for keys, domains, customer names and machine paths.
3. Ensure `credentials_*.md`, `.env*`, backups and raw sessions are ignored.
4. Verify the target repository visibility in GitHub before the first push.

## Sync safety

Syncthing encrypts transport between devices, but it is not a permission model.
Every paired device can receive the folder. Keep the device list small, use
versioning, and remove a lost machine from Syncthing immediately.

Git is revision history. Syncthing is live replication. Do not use one as if it
were the other, and do not let both independently overwrite the same folder.
