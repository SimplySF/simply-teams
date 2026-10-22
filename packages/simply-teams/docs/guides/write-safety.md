---
title: Write safety
description: What happens when Simply Teams posts a message, the layers in front of it, and which of them is a real boundary.
---

A message posted by `channel post`, `message reply`, or `chat send` appears exactly as if you had
typed it in Teams: your name, your photo, and a notification for everyone the post would normally
reach. Nothing marks it as sent by a tool, and notifications cannot be recalled. The layers below
sit in front of that. Only the last one is a real boundary.

## `--dry-run`

Every write command takes it, and so does every write tool in the MCP server (`dryRun`). It prints
the exact request, the path and the body, and sends nothing. Channel names and mentions are still
looked up, so the preview is the real request, but neither send scope is needed.

```sh
simply teams channel post "Platform/General" --text "Deployed 2.3" --mention ada@contoso.com --dry-run
```

## `TEAMS_READ_ONLY`

Set it to `1`, `true`, `yes`, or `on`, in the environment or in an `--env-file`, and every write
command refuses before making any request, with exit code 2. Reads are unaffected. It guards
against running in the wrong context; it is not a security boundary, since anything that can run
commands can also unset a variable.

## `--allow-writes`, twice

- **At sign-in.** The send scopes, `ChannelMessage.Send` and `ChatMessage.Send`, are not part of the
  read set. Only `simply teams auth login --allow-writes` asks for them, and `auth status` shows
  whether you have them on its "Can post" line.
- **In the MCP server.** Started without `--allow-writes`, the server does not register the write
  tools at all, so they are not in the agent's loop.

## A registration that can only read

This is the layer that binds. Microsoft's identity platform puts every scope ever granted to an app
registration into every token it issues, whatever was asked for. Once anyone signs in with
`--allow-writes` against a registration, every later token from it can post.

So use two registrations, as the [app-registration guide](app-registration.md) describes:

```
TEAMS_CLIENT_ID=<simply-teams read-only registration>    # the agent's everyday server
TEAMS_CLIENT_ID=<simply-teams-write registration>         # passed only where posting is meant
```

An agent whose server uses the read-only registration cannot post, whatever it is persuaded to try:
Graph refuses it.

## A failed post is not retried

Graph messages have no idempotency key, so the same request sent twice is two posts, in front of
everyone. A write is retried only when the failure proves Teams did not act: a rate limit (429) or a
connection that was refused. A server error, a dropped connection, or a timeout can follow a message
that was posted, so the command stops and says:

```
The message may have been posted; check before retrying.
```

Look at the channel or chat before running the command again.
