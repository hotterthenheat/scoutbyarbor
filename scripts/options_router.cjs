const fs = require('fs');

const USER_TOKEN = process.env.DISCORD_USER_TOKEN || 'YOUR_USER_TOKEN_HERE';
const DEST_CHANNEL = '1512892264752349305';

const HEADERS = {
    'Authorization': USER_TOKEN,
    'Content-Type': 'application/json'
};

const RULES = {
    '1513300726141419550': {
        "rule_type": "skyspx_alerts",
        "allowed_author_id": "1503116567288877267"
    },
    '1519039282537300209': {
        "rule_type": "photos_only",
        "allowed_author_id": "293852752465887232"
    }
};

const OPTIONS_REGEX = /\b\d+\s*[PC]\b/i;

const SCRUB_PATTERNS = [
    /\(@WalterBloomberg\)/gi,
    /@WalterBloomberg/gi,
    /\bWALTER BLOOMBERG\b/gi,
    /\bNoah_StrikeGexAPP\b/gi,
    /\bNoah_StrikeGex\b/gi,
    /\bOwlsKeyLevelsBot\b/gi,
    /\bunusual_whales_crier\b/gi,
    /\bOWLS Capital Clanker\b/gi,
    /\bAPP\b/gi,
    /Trade at your own risk/gi,
    /For information and data display only/gi,
    /signal, not noise/gi
];

function cleanText(text) {
    let t = text;
    for (const pat of SCRUB_PATTERNS) {
        t = t.replace(pat, '');
    }
    return t.trim();
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

async function fetchLatestMessage(channelId) {
    const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=1`;
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (res.ok) {
            const msgs = await res.json();
            return msgs.length ? msgs[0] : null;
        }
    } catch (e) {
        console.error(`Error fetching channel ${channelId}:`, e);
    }
    return null;
}

function extractEmbedText(embeds = []) {
    const parts = [];
    for (const e of embeds) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
        for (const field of (e.fields || [])) {
            if (field.name) parts.push(field.name);
            if (field.value) parts.push(field.value);
        }
    }
    return parts.join('\n');
}

function extractPhotoUrls(msg) {
    const photos = [];
    for (const att of (msg.attachments || [])) {
        const url = att.url || '';
        const contentType = att.content_type || '';
        if (contentType.includes('image') || IMAGE_EXTENSIONS.some(ext => url.toLowerCase().split('?')[0].endsWith(ext))) {
            photos.push(url);
        }
    }
    for (const embed of (msg.embeds || [])) {
        if (embed.image && embed.image.url) {
            photos.push(embed.image.url);
        } else if (embed.thumbnail && embed.thumbnail.url) {
            photos.push(embed.thumbnail.url);
        }
    }
    return photos;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postMessage(payload) {
    const url = `https://discord.com/api/v9/channels/${DEST_CHANNEL}/messages`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            console.log("--> Successfully routed to destination channel.");
        } else {
            console.warn(`--> Discord returned status code ${res.status}`);
        }
    } catch (e) {
        console.error("--> Failed to send message:", e);
    }
}

async function main() {
    console.log("Initializing Router...");
    const lastMessageIds = {};

    for (const ch of Object.keys(RULES)) {
        const msg = await fetchLatestMessage(ch);
        if (msg) lastMessageIds[ch] = msg.id;
    }

    console.log("Router Active. Monitoring channels...");

    while (true) {
        for (const [sourceCh, config] of Object.entries(RULES)) {
            const msg = await fetchLatestMessage(sourceCh);
            if (!msg) continue;

            const msgId = msg.id;
            if (lastMessageIds[sourceCh] !== msgId) {
                lastMessageIds[sourceCh] = msgId;

                const authorId = msg.author ? msg.author.id : '';
                if (authorId !== config.allowed_author_id) {
                    console.log(`Skipped message from unauthorized author ID: ${authorId} in channel ${sourceCh}`);
                    continue;
                }

                if (config.rule_type === "skyspx_alerts") {
                    const rawContent = msg.content || '';
                    const embedContent = extractEmbedText(msg.embeds);
                    const combinedText = `${rawContent}\n${embedContent}`.trim();

                    if (OPTIONS_REGEX.test(combinedText)) {
                        const cardUi = `>>> **SkySPX Alert**\n${cleanText(combinedText)}\n\n\`System: Information and Data Display Only\``;
                        await postMessage({ content: cardUi });
                    } else {
                        console.log("--> Skipped: Message did not contain required contract pattern.");
                    }
                } else if (config.rule_type === "photos_only") {
                    const photoUrls = extractPhotoUrls(msg);
                    if (photoUrls.length > 0) {
                        for (const url of photoUrls) {
                            const cardUi = `>>> **DONOTFALL CHART ALERTS**\n${url}\n\n\`System: Information and Data Display Only\``;
                            await postMessage({ content: cardUi });
                            await sleep(300);
                        }
                    } else {
                        console.log("--> Skipped: No photos found in message.");
                    }
                }
            }
        }
        await sleep(500);
    }
}

main();
