# OpenClaw acpx integration note: `queue owner unavailable`

This note explains why `extensions/acpx/src/runtime.ts` intentionally retains a
named session when `acpx status` reports:

- `status=dead`
- `summary=queue owner unavailable`

## The production failure

The original failure looked like random Claude ACP processes appearing after a
task had already finished. RAM kept climbing until the machine hit OOM.

The root cause was two bugs working together:

1. OpenClaw maintenance rechecked finished ACP tasks that should have remained
   history-only.
2. The OpenClaw `acpx` integration treated `queue owner unavailable` like a
   hard-dead session and replaced the named session immediately.

That replacement path was especially expensive when the configured ACP agent
command used a launcher chain such as:

- `npm`
- `sh`
- `claude-agent-acp`
- `claude`

Each unnecessary replacement could leave behind extra descendant processes if
the backend cleanup was incomplete.

## What `queue owner unavailable` actually means

In `acpx`, this status is about the temporary queue owner being unavailable
right now. It is **not** by itself proof that the durable named session is
gone or unrecoverable.

That means this state is often recoverable through later prompt/load behavior.

So the correct OpenClaw behavior is:

- retain the named session
- do not replace it just because the current queue owner is unavailable

## What the OpenClaw fix does

`extensions/acpx/src/runtime.ts` now treats this exact combination as
recoverable:

- `status=dead`
- `summary` contains `queue owner unavailable`

In both places where OpenClaw probes `acpx status`:

1. after a normal `sessions ensure`
2. after recovering from an `ensure` failure

OpenClaw now keeps the named session instead of recreating it.

## What this fix does not do

This source change stops the bad OpenClaw repair loop.

It does **not** replace the separate backend cleanup fix for launcher-based ACP
commands. That fix is handled locally through the version-pinned `acpx`
post-install diff in the plugin repo.

Both pieces matter:

- OpenClaw source fix: stop unnecessary replacement
- local `acpx` diff: clean up launcher-based descendants correctly
