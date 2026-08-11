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

── PER-SOURCE ROUTING AND FILTERING ─────────────────────────────────────────

One source forwarded wholesale, another filtered down to a single bot and a
single keyword:

    export SCOUT_RELAY_ROUTES='[
      {"source": 1081082844807434292, "dest": 1512892264752349305},
      {"source": 1337165306858049546, "dest": 1512892264752349305,
       "author": "owls capital clanker", "contains": "NEWS ALERT"}
    ]'

`author` and `contains` are case-insensitive substring matches, and `contains`
searches the embeds as well as the content — a headline bot puts "NEWS ALERT"
in an embed title as often as in message.content.

── THE LIMIT WORTH KNOWING BEFORE YOU START ─────────────────────────────────

A bot reads channels it has been INVITED to and no others. If a source server
has not added this bot, nothing in this file can reach it, and no amount of
code changes that — the fix is the server owner adding the bot, or someone in
that server forwarding into a channel you control.

The alternative people reach for is a user token with a browser User-Agent,
driving a personal account through the private client API. That is account
termination under Discord's terms, and the account it terminates is the one
holding your servers, your intake channel and Scout's own bot — so the failure
mode is not "the relay stops", it is "everything stops at once, permanently".
This file does not do that, and there is no flag to make it.

If the source channel is an ANNOUNCEMENT channel, do not run this at all —
Discord's own "Follow" mirrors it into your server automatically, with better
attribution and nothing to keep running.
"""

import os
import sys
import json
import logging

import discord

log = logging.getLogger("scout-relay")

# ── Configuration ────────────────────────────────────────────────────────────

TOKEN = os.environ.get("SCOUT_RELAY_TOKEN", "")

# Per-source routing, when one target and no filtering is not enough.
#
#   SCOUT_RELAY_ROUTES='[
#     {"source": 1081082844807434292, "dest": 1512892264752349305},
#     {"source": 1337165306858049546, "dest": 1512892264752349305,
#      "author": "owls capital clanker", "contains": "NEWS ALERT"}
#   ]'
#
# `author` matches the display name case-insensitively as a substring, and
# `contains` requires the text somewhere in the message OR its embeds — a
# headline bot puts "NEWS ALERT" in an embed title as often as in the content,
# and matching only message.content silently forwards nothing.
#
# Omit both and every message in that source is forwarded. Omit the variable
# entirely and SCOUT_RELAY_SOURCE_CHANNELS/SCOUT_RELAY_TARGET_CHANNEL apply
# unchanged.
ROUTES_JSON = os.environ.get("SCOUT_RELAY_ROUTES", "").strip()


class Route:
    __slots__ = ("source", "dest", "author", "contains")

    def __init__(self, source: int, dest: int, author: str | None, contains: str | None):
        self.source = source
        self.dest = dest
        self.author = (author or "").strip().lower() or None
        self.contains = (contains or "").strip().lower() or None

    def accepts(self, author_name: str, haystack: str) -> bool:
        if self.author and self.author not in author_name.lower():
            return False
        if self.contains and self.contains not in haystack.lower():
            return False
        return True

    def describe(self) -> str:
        bits = []
        if self.author:
            bits.append(f'author~"{self.author}"')
        if self.contains:
            bits.append(f'contains "{self.contains}"')
        return f"{self.source} → {self.dest}" + (f" [{', '.join(bits)}]" if bits else "")


def _parse_routes(raw: str) -> list[Route]:
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as err:
        sys.exit(f"SCOUT_RELAY_ROUTES is not valid JSON: {err}")
    if not isinstance(entries, list):
        sys.exit("SCOUT_RELAY_ROUTES must be a JSON array of route objects")

    routes: list[Route] = []
    for entry in entries:
        if not isinstance(entry, dict):
            sys.exit(f"SCOUT_RELAY_ROUTES entry is not an object: {entry!r}")
        try:
            source = int(entry["source"])
            dest = int(entry["dest"])
        except (KeyError, TypeError, ValueError):
            sys.exit(f'SCOUT_RELAY_ROUTES entry needs numeric "source" and "dest": {entry!r}')
        # A source that is also a destination relays its own output back into
        # itself, forever.
        if source == dest:
            sys.exit(f"SCOUT_RELAY_ROUTES route {source} forwards a channel into itself")
        routes.append(Route(source, dest, entry.get("author"), entry.get("contains")))
    return routes


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

# Explicit routes win. Otherwise every source fans out to every target, which
# is the original behaviour.
if ROUTES_JSON:
    ROUTES = _parse_routes(ROUTES_JSON)
else:
    ROUTES = [
        Route(source, target, None, None)
        for source in SOURCE_CHANNEL_IDS
        for target in TARGET_CHANNEL_IDS
    ]

ROUTES_BY_SOURCE: dict[int, list[Route]] = {}
for _route in ROUTES:
    ROUTES_BY_SOURCE.setdefault(_route.source, []).append(_route)

# A channel that is both a source and a destination relays its own output.
_destinations = {r.dest for r in ROUTES}
for _source in ROUTES_BY_SOURCE:
    if _source in _destinations:
        sys.exit(
            f"channel {_source} is configured as both a source and a destination — "
            "the relay would forward its own messages back into itself"
        )

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


def _searchable_text(message: discord.Message) -> str:
    """Content plus every embed field a filter might reasonably match on."""
    parts = [message.content or ""]
    for embed in message.embeds:
        parts.extend(
            str(x) for x in (embed.title, embed.description, getattr(embed.author, "name", None))
            if x
        )
        for field in embed.fields:
            parts.extend(str(x) for x in (field.name, field.value) if x)
        if embed.footer and embed.footer.text:
            parts.append(str(embed.footer.text))
    return "\n".join(parts)


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

    routes = ROUTES_BY_SOURCE.get(message.channel.id)
    if not routes:
        return

    # Bots are NOT skipped: a market-alert bot is usually the thing worth
    # relaying. Only this relay's own messages are excluded, above.

    # Filters read the embeds as well as the content. A headline bot puts
    # "NEWS ALERT" in an embed title at least as often as in message.content,
    # and matching content alone forwards nothing while looking configured.
    author_name = message.author.display_name
    haystack = _searchable_text(message)

    matched = [r for r in routes if r.accepts(author_name, haystack)]
    if not matched:
        return

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

    for target_id in {r.dest for r in matched}:
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
