# Scout relay

Forwards messages from source channels into Scout's intake channel, so Scout
sees servers it is not itself a member of.

Runs on a **bot token** from the Discord developer portal, in servers your bot
has been invited to. It runs 24/7 on its own — that is what a bot token is for.
No user token, no session cookie, no browser automation, no personal account.

## Before you run this: two better options

**1. Follow the channel.** If the source is an *Announcement* channel, Discord's
own channel-following mirrors it into your server automatically. Nothing to run,
nothing to keep alive, and the original author, source link and timestamp arrive
intact. Scout detects these as `crosspost` and treats attribution as fully
preserved. Ask the server owner to let you follow it.

**2. Ask the owner for a webhook** pointed at your intake channel. Also nothing
to keep running.

Use this relay when neither is available.

## What permission to ask the server owner for

Ask for a **bot invite**, not for account credentials. The invite needs:

- View Channel
- Read Message History

on the source channel only. An owner's permission cannot authorize a Discord
Terms of Service violation — that agreement is between you and Discord, and a
self-bot ban lands on your account regardless of who said it was fine. A bot
invite is one click for the owner and carries no such risk.

## Setup

1. Developer portal → your app → Bot → enable **MESSAGE CONTENT INTENT**.
2. Invite the bot to the source server (View Channel, Read Message History) and
   to the server holding the intake channel (Send Messages, Embed Links).
3. Configure and run:

```sh
pip install -U discord.py

export SCOUT_RELAY_TOKEN="…"                      # BOT token, never a user token
export SCOUT_RELAY_SOURCE_CHANNELS="111…,333…"    # comma-separated
export SCOUT_RELAY_TARGET_CHANNEL="1513342006342979635"

python relay.py
```

The token is read from the environment on purpose. A token pasted into source
ends up in git, and Discord invalidates tokens it finds there.

## Why it forwards embeds

Most market-alert bots put **nothing** in `message.content` — the headline, the
figure and the timestamp all live in an embed. A relay that forwards only
`message.content` forwards an empty string for exactly the sources worth
relaying. This one forwards the embeds too.

## What Scout reads

The relay emits an attribution embed alongside the original content, and Scout
parses it to recover who **originally** said something:

| Field | Becomes |
| --- | --- |
| `embed.author.name` | the original author — the byline |
| `embed.footer.text` (`#channel • Server`) | origin channel and server |
| `embed.timestamp` | when the ORIGINAL was posted |
| `embed.url` | jump link back to the source message |

The timestamp matters most. Scout's freshness gate reads publication time, and a
relay that stamps its own send time makes an hour-old headline look like it broke
seconds ago — which is the one failure the gate exists to prevent.

Scout never credits the relay bot as the source. If a relayed message arrives
without recoverable attribution, the event is recorded as
`unattributed via <relay>` rather than attributed to whoever forwarded it.

## Safety rails

- Refuses to start if a channel is both a source and a target (an unbounded loop).
- Skips its own messages.
- Does **not** skip other bots — a market-alert bot is usually the thing worth relaying.
- Logs loudly on boot if a configured channel is not visible to the bot. Silently
  relaying nothing looks exactly like a quiet news day.
- A failed send is logged, not fatal.
