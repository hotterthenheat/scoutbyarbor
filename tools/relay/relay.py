"""
Scout relay — forwards messages from source channels into Scout's intake channel.

This runs on YOUR bot token from the Discord developer portal, in servers your
bot has been invited to. It is not a self-bot: no user token, no session cookie,
no browser automation. Nothing here touches a personal account.

── WHY NOT JUST message.content ─────────────────────────────────────────────

Most market-alert bots put nothing in message.content. The headline, the figure
and the timestamp all live in an EMBED, and a relay that forwards only
`message.content` forwards an empty string for exactly the sources worth
relaying. This script forwards the embeds too.

── WHAT SCOUT READS ─────────────────────────────────────────────────────────

Scout parses the relayed message to recover who ORIGINALLY said it, and refuses
to credit the relay bot when it cannot. This script emits an attribution embed
whose author, footer and timestamp Scout reads directly, so events arrive with
full attribution rather than as "unattributed via <relay>":

    embed.author.name  → the original author
    embed.footer.text  → "#channel • Server"
    embed.timestamp    → when the ORIGINAL was posted, not when it was relayed
    embed.url          → a jump link back to the source message

The timestamp matters most. Scout's freshness gate reads publication time, and
a relay that stamps its own send time makes an hour-old headline look like it
broke seconds ago.

── BEFORE IT WORKS ──────────────────────────────────────────────────────────

1. Discord developer portal → your app → Bot → enable MESSAGE CONTENT INTENT.
2. Invite the bot to the SOURCE server (needs View Channel + Read Message
   History) and to the server holding the intake channel (needs Send Messages
   and Embed Links).
3. Set the environment variables below. The token is read from the environment
   on purpose — a token pasted into source ends up in git.

    export SCOUT_RELAY_TOKEN="…"
    export SCOUT_RELAY_SOURCE_CHANNELS="111111111111111111,333333333333333333"
    export SCOUT_RELAY_TARGET_CHANNEL="1513342006342979635"

    pip install -U discord.py
    python relay.py

If the source channel is an ANNOUNCEMENT channel, do not run this at all —
Discord's own "Follow" mirrors it into your server automatically, with better
attribution and nothing to keep running.
"""

import os
import sys
import logging

import discord

log = logging.getLogger("scout-relay")

# ── Configuration ────────────────────────────────────────────────────────────

TOKEN = os.environ.get("SCOUT_RELAY_TOKEN", "")


def _channel_ids(name: str) -> list[int]:
    raw = os.environ.get(name, "")
    out: list[int] = []
    for part in raw.replace(" ", "").split(","):
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            sys.exit(f"{name} contains a non-numeric channel id: {part!r}")
    return out


SOURCE_CHANNEL_IDS = set(_channel_ids("SCOUT_RELAY_SOURCE_CHANNELS"))
TARGET_CHANNEL_IDS = _channel_ids("SCOUT_RELAY_TARGET_CHANNEL")

# Discord rejects a message with more than 10 embeds. One is ours.
MAX_FORWARDED_EMBEDS = 9
# Embed descriptions are capped at 4096; leave room for the truncation marker.
MAX_DESCRIPTION = 4000

intents = discord.Intents.default()
intents.message_content = True

client = discord.Client(intents=intents)


@client.event
async def on_ready() -> None:
    log.info("logged in as %s", client.user)
    log.info("watching %d source channel(s)", len(SOURCE_CHANNEL_IDS))

    # Fail loudly on a channel the bot cannot actually see. Silently relaying
    # nothing looks identical to a quiet news day, and that is the failure you
    # find three weeks later.
    for channel_id in SOURCE_CHANNEL_IDS:
        if client.get_channel(channel_id) is None:
            log.error(
                "source channel %s is not visible to this bot — is it invited to "
                "that server, and does it have View Channel + Read Message History?",
                channel_id,
            )
    for channel_id in TARGET_CHANNEL_IDS:
        if client.get_channel(channel_id) is None:
            log.error("target channel %s is not visible to this bot", channel_id)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _origin_footer(message: discord.Message) -> str:
    """`#channel • Server` — the form Scout's footer parser reads."""
    channel_name = getattr(message.channel, "name", None) or str(message.channel.id)
    guild_name = message.guild.name if message.guild else "direct message"
    return f"#{channel_name} • {guild_name}"


def _attribution_embed(message: discord.Message) -> discord.Embed:
    """
    The embed Scout reads attribution out of.

    Every field here is a fact from the source message. Nothing is invented: an
    absent author name or timestamp is left absent, and Scout records the gap
    honestly rather than filling it with the relay's own identity.
    """
    embed = discord.Embed(
        description=_truncate(message.content, MAX_DESCRIPTION) or None,
        # The ORIGINAL publication time. This is the field the freshness gate
        # ends up reading, and the single most important one here.
        timestamp=message.created_at,
    )
    embed.set_author(name=message.author.display_name, url=message.jump_url)
    embed.set_footer(text=_origin_footer(message))
    embed.url = message.jump_url

    # Attachments are kept for audit. Scout never renders them into an alert.
    if message.attachments:
        embed.add_field(
            name="attachments",
            value="\n".join(a.url for a in message.attachments)[:1024],
            inline=False,
        )
    return embed


@client.event
async def on_message(message: discord.Message) -> None:
    # Our own posts, first. Without this, relaying into a channel this bot also
    # watches is an infinite loop.
    if message.author == client.user:
        return

    if message.channel.id not in SOURCE_CHANNEL_IDS:
        return

    # Bots are NOT skipped: a market-alert bot is usually the thing worth
    # relaying. Only this relay's own messages are excluded, above.

    embeds = [_attribution_embed(message)]
    # The original embeds, forwarded rather than dropped. This is where a
    # market-alert bot puts the headline, the figure and the ticker.
    embeds.extend(message.embeds[:MAX_FORWARDED_EMBEDS])

    if message.embeds[MAX_FORWARDED_EMBEDS:]:
        log.warning(
            "message %s had %d embeds; forwarded the first %d",
            message.id,
            len(message.embeds),
            MAX_FORWARDED_EMBEDS,
        )

    for target_id in TARGET_CHANNEL_IDS:
        target = client.get_channel(target_id)
        if target is None:
            log.error("target channel %s is unavailable; dropped %s", target_id, message.id)
            continue
        try:
            # discord.py handles rate limits by waiting, so a burst is delayed
            # rather than lost.
            await target.send(embeds=embeds)
        except discord.HTTPException:
            # One failed relay must not kill the process. Scout tolerates a
            # missing message; it does not tolerate a relay that silently died.
            log.exception("failed to relay %s into %s", message.id, target_id)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if not TOKEN:
        sys.exit("SCOUT_RELAY_TOKEN is not set. Use a BOT token from the developer portal.")
    if not SOURCE_CHANNEL_IDS:
        sys.exit("SCOUT_RELAY_SOURCE_CHANNELS is not set; there is nothing to relay.")
    if not TARGET_CHANNEL_IDS:
        sys.exit("SCOUT_RELAY_TARGET_CHANNEL is not set; there is nowhere to relay to.")

    overlap = SOURCE_CHANNEL_IDS.intersection(TARGET_CHANNEL_IDS)
    if overlap:
        # Relaying a channel into itself is an unbounded loop that stops only
        # when Discord rate-limits the bot.
        sys.exit(f"channel(s) {sorted(overlap)} are both a source and a target")

    client.run(TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
