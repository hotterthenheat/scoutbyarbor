import { Client, IntentsBitField, EmbedBuilder } from 'discord.js';

const TOKEN = process.env.SCOUT_RELAY_TOKEN;
const DEST_CHANNEL_ID = '1512892264752349305';

const ROUTES: Record<string, { target_author: string | null; required_text: string | null }> = {
  // Channel 1: Forward ALL messages
  '1081082844807434292': {
    target_author: null,
    required_text: null,
  },
  // Channel 2: Filter for "owls capital clanker" AND "NEWS ALERT"
  '1337165306858049546': {
    target_author: 'owls capital clanker',
    required_text: 'NEWS ALERT',
  },
};

export async function startRelayBot() {
  if (!TOKEN) {
    console.log('Relay bot disabled: SCOUT_RELAY_TOKEN not set.');
    return;
  }

  const client = new Client({
    intents: [IntentsBitField.Flags.Guilds, IntentsBitField.Flags.GuildMessages, IntentsBitField.Flags.MessageContent],
  });

  client.on('ready', () => {
    console.log(`=== Icarus Relay Bot Online as ${client.user?.tag} ===`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.id === client.user?.id) return;

    const rules = ROUTES[message.channel.id];
    if (!rules) return;
    
    console.log(`[Relay Bot] Detected message in ${message.channel.id} from ${message.author.username}`);

    const authorName = message.author.globalName || message.author.username;
    const content = message.content;

    // Filter 1: Check Author Name
    if (rules.target_author) {
      if (!authorName.toLowerCase().includes(rules.target_author.toLowerCase())) {
        console.log(`[Relay Bot] Message rejected: author ${authorName} did not match target ${rules.target_author}`);
        return;
      }
    }

    // Filter 2: Check Required Text (scans both the raw message and embed text)
    if (rules.required_text) {
      const embedText = message.embeds
        .map((e) => `${e.title || ''} ${e.description || ''}`)
        .join(' ');
      const combinedText = `${content} ${embedText}`.toLowerCase();
      if (!combinedText.includes(rules.required_text.toLowerCase())) {
        console.log(`[Relay Bot] Message rejected: content did not match target text ${rules.required_text}`);
        return;
      }
    }

    console.log(`[Relay Bot] Message passed filters, fetching destination channel ${DEST_CHANNEL_ID}...`);
    const destChannel = await client.channels.fetch(DEST_CHANNEL_ID).catch((err) => {
      console.log(`[Relay Bot] Error fetching destination channel:`, err);
      return null;
    }) as import('discord.js').TextChannel | null;
    
    if (destChannel) {
      const card = new EmbedBuilder()
        .setDescription(content || '*[Attachment / Embed Data]*')
        .setColor(0x2b2d31)
        .setAuthor({
          name: `Source: ${authorName}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setFooter({ text: '⚡ Sent via Icarus | Arbor Capital — For information and data display only.' });

      const firstImageAttachment = message.attachments.find((att) => att.contentType?.startsWith('image/'));
      if (firstImageAttachment) {
        card.setImage(firstImageAttachment.url);
      } else {
        const firstEmbedImage = message.embeds.find((e) => e.image?.url);
        if (firstEmbedImage && firstEmbedImage.image) {
          card.setImage(firstEmbedImage.image.url);
        }
      }

      await destChannel.send({ embeds: [card] }).catch(err => {
        console.log(`[Relay Bot] Failed to send to destination channel:`, err);
      });
      console.log(`[Relay Bot] Successfully forwarded data from ${authorName}`);
    } else {
      console.log(`[Relay Bot] Destination channel ${DEST_CHANNEL_ID} could not be resolved or fetched.`);
    }
  });

  await client.login(TOKEN);
}
