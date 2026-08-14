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

import os

# Authentication and Endpoint Configuration
USER_TOKEN = os.environ.get('DISCORD_USER_TOKEN', 'YOUR_USER_TOKEN_HERE')
DEST_CHANNEL = 1512892264752349305

HEADERS = {
    'Authorization': USER_TOKEN,
    'Content-Type': 'application/json'
}

# Source Channels
SOURCE_CHANNELS = [
    1081082844807434292,
    1480464269735755799
]

# Patterns & Names to scrub completely from messages
SCRUB_PATTERNS = [
    r'\(@WalterBloomberg\)',
    r'@WalterBloomberg',
    r'\bWALTER BLOOMBERG\b',
    r'\bNoah_StrikeGexAPP\b',
    r'\bNoah_StrikeGex\b',
    r'\bOwlsKeyLevelsBot\b',
    r'\bunusual_whales_crier\b',
    r'\bOWLS Capital Clanker\b',
    r'\bAPP\b',
    r'Trade at your own risk',
    r'For information and data display only',
    r'signal, not noise',
    r'Scout by'
]

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

def strip_all_links(text):
    if not text:
        return ""
    # Strip markdown links [label](url)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Strip standard URLs
    text = re.sub(r'https?://\S+|www\.\S+', '', text)
    return text

def clean_text(text):
    if not text:
        return ""

    # Strip all links first
    text = strip_all_links(text)
    text = re.sub(r'[\u202f\xa0]', ' ', text)

    # Scrub unwanted bot names and handles
    for pattern in SCRUB_PATTERNS:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE)

    # Clean leftover formatting artifacts
    text = re.sub(r'^\*{1,2}|\*{1,2}$', '', text.strip())
    text = re.sub(r'^[:\-·•\|\s]+|[:\-·•\|\s]+$', '', text)
    text = re.sub(r'\n\s*\n', '\n\n', text)

    return text.strip()

def split_into_individual_headlines(raw_text):
    # Splits multi-headline posts by timestamp (e.g. 4:03 PM)
    items = re.split(r'(?=\b\d{1,2}:\d{2}\s*[AP]M\b)', raw_text)
    
    headline_list = []
    for item in items:
        lines = item.split('\n')
        for line in lines:
            cleaned_line = line.strip()
            cleaned_line = re.sub(r'^[•\-\s]+', '', cleaned_line)
            if len(cleaned_line) > 5:
                headline_list.append(cleaned_line)
                
    return headline_list

def route_headline(session, headline):
    url = f"https://discord.com/api/v9/channels/{DEST_CHANNEL}/messages"
    card_ui = (
        f">>> **Data Alert**\n"
        f"{headline}\n\n"
        f"`System: Information and Data Display Only`"
    )
    try:
        res = session.post(url, json={"content": card_ui}, timeout=5)
        if res.status_code == 200:
            logging.info("--> Headline routed cleanly to UI.")
        else:
            logging.warning(f"--> Discord rejected message (Status {res.status_code})")
    except Exception as e:
        logging.error(f"--> Failed to route headline: {e}")

def main():
    logging.info("Initializing Router...")
    session = requests.Session()
    session.headers.update(HEADERS)
    last_message_ids = {}

    # Set baseline IDs so old history is not re-forwarded
    for ch in SOURCE_CHANNELS:
        msg = fetch_latest_message(session, ch)
        if msg:
            last_message_ids[ch] = msg['id']

    logging.info("Router Active. Scanning for new data...")

    while True:
        for source_ch in SOURCE_CHANNELS:
            msg = fetch_latest_message(session, source_ch)
            if not msg:
                continue

            msg_id = msg['id']
            if last_message_ids.get(source_ch) != msg_id:
                last_message_ids[source_ch] = msg_id

                author_obj = msg.get('author', {})
                author_name = (author_obj.get('global_name') or author_obj.get('username') or '').lower()

                logging.info(f"New activity detected in channel {source_ch} from '{author_name}'")

                # Extract text content only (ignoring link embeds)
                raw_content = msg.get('content', '')

                # Also grab text description if the bot posted via rich text embed (no urls)
                embed_text = []
                for embed in msg.get('embeds', []):
                    if isinstance(embed, dict):
                        if embed.get('title'):
                            embed_text.append(embed['title'])
                        if embed.get('description'):
                            embed_text.append(embed['description'])
                        for field in embed.get('fields', []):
                            if isinstance(field, dict):
                                if field.get('name'):
                                    embed_text.append(field['name'])
                                if field.get('value'):
                                    embed_text.append(field['value'])

                combined_text = f"{raw_content}\n" + "\n".join(embed_text)
                cleaned_text = clean_text(combined_text)

                if not cleaned_text:
                    logging.info("--> Skipped: Content was empty after stripping links/blocked names.")
                    continue

                headlines = split_into_individual_headlines(cleaned_text)

                for headline in headlines:
                    route_headline(session, headline)
                    time.sleep(0.3)

        time.sleep(0.5)

if __name__ == "__main__":
    main()
