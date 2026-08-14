import os
import warnings
warnings.filterwarnings('ignore')

import requests
import time
import re
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s'
)

# Authentication and Endpoint Configuration
USER_TOKEN = os.environ.get('DISCORD_USER_TOKEN', 'YOUR_USER_TOKEN_HERE')
DEST_CHANNEL = 1512892264752349305

HEADERS = {
    'Authorization': USER_TOKEN,
    'Content-Type': 'application/json'
}

# Source Channel Configurations and Author Rules
RULES = {
    1513300726141419550: {
        "rule_type": "skyspx_alerts",
        "allowed_author_id": "1503116567288877267"
    },
    1519039282537300209: {
        "rule_type": "photos_only",
        "allowed_author_id": "293852752465887232"
    }
}

# Regex to match options contracts like 7780P, 472C, 48C, 44P
OPTIONS_REGEX = re.compile(r'\b\d+\s*[PC]\b', re.IGNORECASE)

IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp', '.gif')

def fetch_latest_message(session, channel_id):
    url = f"https://discord.com/api/v9/channels/{channel_id}/messages?limit=1"
    try:
        res = session.get(url, timeout=5)
        if res.status_code == 200:
            msgs = res.json()
            return msgs[0] if msgs else None
    except Exception as e:
        logging.error(f"Error fetching channel {channel_id}: {e}")
    return None

def extract_embed_text(embeds):
    parts = []
    for e in embeds:
        if not isinstance(e, dict):
            continue
        if e.get('title'):
            parts.append(e['title'])
        if e.get('description'):
            parts.append(e['description'])
        for field in e.get('fields', []):
            if isinstance(field, dict):
                if field.get('name'):
                    parts.append(field['name'])
                if field.get('value'):
                    parts.append(field['value'])
    return "\n".join(parts)

def extract_photo_urls(msg):
    photos = []
    # Check direct attachments
    for att in msg.get('attachments', []):
        if isinstance(att, dict):
            url = att.get('url', '')
            content_type = att.get('content_type', '')
            if 'image' in content_type or url.lower().split('?')[0].endswith(IMAGE_EXTENSIONS):
                photos.append(url)

    # Check embed images
    for embed in msg.get('embeds', []):
        if isinstance(embed, dict):
            if embed.get('image', {}).get('url'):
                photos.append(embed['image']['url'])
            elif embed.get('thumbnail', {}).get('url'):
                photos.append(embed['thumbnail']['url'])

    return photos

def post_message(session, payload):
    url = f"https://discord.com/api/v9/channels/{DEST_CHANNEL}/messages"
    try:
        res = session.post(url, json=payload, timeout=5)
        if res.status_code == 200:
            logging.info("--> Successfully routed to destination channel.")
        else:
            logging.warning(f"--> Discord returned status code {res.status_code}")
    except Exception as e:
        logging.error(f"--> Failed to send message: {e}")

def main():
    logging.info("Initializing Router...")
    session = requests.Session()
    session.headers.update(HEADERS)
    last_message_ids = {}

    # Set baselines so old messages are not resent
    for ch in RULES.keys():
        msg = fetch_latest_message(session, ch)
        if msg:
            last_message_ids[ch] = msg['id']

    logging.info("Router Active. Monitoring channels...")

    while True:
        for source_ch, config in RULES.items():
            msg = fetch_latest_message(session, source_ch)
            if not msg:
                continue

            msg_id = msg['id']
            if last_message_ids.get(source_ch) != msg_id:
                last_message_ids[source_ch] = msg_id

                author_id = str(msg.get('author', {}).get('id', ''))
                expected_author_id = config["allowed_author_id"]

                # Strict author ID validation
                if author_id != expected_author_id:
                    logging.info(f"Skipped message from unauthorized author ID: {author_id} in channel {source_ch}")
                    continue

                rule_type = config["rule_type"]

                # Logic for SkySPX Alerts
                if rule_type == "skyspx_alerts":
                    raw_content = msg.get('content', '')
                    embed_content = extract_embed_text(msg.get('embeds', []))
                    combined_text = f"{raw_content}\n{embed_content}".strip()

                    # Match for strikes like 7780P, 472C, 48C, 44P
                    if OPTIONS_REGEX.search(combined_text):
                        card_ui = (
                            f">>> **SkySPX Alert**\n"
                            f"{combined_text}\n\n"
                            f"`System: Information and Data Display Only`"
                        )
                        post_message(session, {"content": card_ui})
                    else:
                        logging.info("--> Skipped: Message did not contain required contract pattern (e.g. 7780P, 472C).")

                # Logic for Photos Only
                elif rule_type == "photos_only":
                    photo_urls = extract_photo_urls(msg)
                    if photo_urls:
                        for photo_url in photo_urls:
                            card_ui = (
                                f">>> **DONOTFALL CHART ALERTS**\n"
                                f"{photo_url}\n\n"
                                f"`System: Information and Data Display Only`"
                            )
                            post_message(session, {"content": card_ui})
                            time.sleep(0.3)
                    else:
                        logging.info("--> Skipped: No photos found in message.")

        time.sleep(0.5)

if __name__ == "__main__":
    main()
