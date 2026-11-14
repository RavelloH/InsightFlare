# Self-hosted administrator password recovery

Use the operator CLI when you cannot sign in to your self-hosted InsightFlare dashboard. It updates the password hash for one existing account in remote D1; it does not expose a public reset endpoint.

## Before you start

- Work from a local clone of the InsightFlare repository and install its dependencies with `pnpm install`.
- Use an interactive terminal. The command asks you to confirm the username and enter the new password twice without displaying it. It cannot run unattended.
- Make sure your Cloudflare CLI session has access to the account and permission to query and update the target D1 database.
- Identify the correct deployment, environment, and D1 database before running the command. The command displays the selected user and asks you to type `RESET <username>` before it changes anything.

`BOOTSTRAP_ADMIN_PASSWORD` is only used when InsightFlare creates the initial administrator because no administrator exists yet. Changing that Cloudflare secret does not change the password of an existing account. Use the reset command below for an existing account.

## Cloudflare `cf` CLI

The `cf` CLI is installed with the repository's development dependencies. It requires Node.js `^22.23.0`, `^24.22.0`, or `^26.12.0`; use a supported Node.js release before installing dependencies. Authenticate to Cloudflare:

```sh
pnpm install
pnpm exec cf auth login
```

Set `CLOUDFLARE_ACCOUNT_ID` to the account ID shown in your Cloudflare dashboard, especially if your login has access to multiple accounts. The recovery command captures CLI output and cannot answer a CLI account-selection prompt. In PowerShell, use `$env:CLOUDFLARE_ACCOUNT_ID = "<ACCOUNT_ID>"`; in a POSIX shell, use `export CLOUDFLARE_ACCOUNT_ID="<ACCOUNT_ID>"`. This is the account ID, not the D1 database UUID.

Find the database UUID in the Cloudflare dashboard under **Workers & Pages > D1**. The `cf` command does not read `wrangler.toml`, so pass the UUID explicitly:

```sh
pnpm run ops:admin:reset-password -- --cli cf --user admin --database <D1_DATABASE_UUID>
```

If you use a named `cf` authentication profile, add `--profile <profile-name>`:

```sh
pnpm run ops:admin:reset-password -- --cli cf --user admin --database <D1_DATABASE_UUID> --profile <profile-name>
```

`--config` and `--env` apply only to Wrangler and are rejected in `cf` mode. `--profile` applies only to `cf`. Both modes always target remote D1.

Use the username that currently exists in the dashboard. For a deployment created with the Cloudflare Deploy button, clone this repository locally, install dependencies, authenticate to the same Cloudflare account, and use the UUID of that deployment's D1 database.

## Wrangler

The existing Wrangler flow remains available and is the default. Wrangler must be installed with the repository dependencies and authenticated for the correct Cloudflare account:

```sh
pnpm install
pnpm exec wrangler login
pnpm run ops:admin:reset-password -- --user admin
```

Wrangler reads `wrangler.toml` by default and targets remote D1. Use `--env <environment>` for a configured environment, `--config <path>` for another Wrangler configuration, or `--database <binding-or-database-name>` to choose a different D1 binding or name. Confirm that this configuration points to the intended deployment before approving the reset.

## After the reset

The command verifies that the selected account's new password hash was stored. It changes only that account's password hash; existing sessions remain valid until they expire. Sign out, or open a private browser window, and sign in to the intended deployment with the recovered username and new password.

Do not put the password in command-line arguments, environment variables, issue comments, shell history, or logs. The command prompts for it without echoing the input.
