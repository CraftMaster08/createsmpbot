import 'dotenv/config';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';
import pkg from 'discord.js';
const { Client, ActivityType } = pkg;

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
// To keep track of our active games
const activeGames = {};

// Minimal Discord gateway client to set bot presence (makes bot appear online)
const gatewayClient = new Client({ intents: [] });
function setPresenceOnReady() {
  try {
    console.log('Gateway client ready as', gatewayClient.user.tag);
    gatewayClient.user.setPresence({
      activities: [{ name: 'Autism SMP', type: ActivityType.Playing }],
      status: 'online',
    });
  } catch (err) {
    console.error('Error setting presence', err);
  }
}

// Support both old and new ready event names
//gatewayClient.once('ready', setPresenceOnReady);
gatewayClient.once('clientReady', setPresenceOnReady);

gatewayClient.login(process.env.DISCORD_TOKEN).catch((err) => console.error('Gateway login failed', err));

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    // "smpstatus" command - query Minecraft server status
    if (name === 'smpstatus') {
      const host = process.env.MINECRAFT_SERVER_IP;
      const port = parseInt(process.env.MINECRAFT_PORT || '25565', 10);
      const token = req.body.token;

      // Acknowledge immediately so Discord doesn't time out the interaction.
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      const respondWithEmbed = async () => {
        const buildStatusEmbed = (isOnline, queryInfo, statusInfo, timeoutHit = false) => {
          const color = isOnline ? 0x2ecc71 : 0xe74c3c;
          const version = queryInfo?.version || statusInfo?.version?.name || statusInfo?.version || 'unknown';
          const playersOnline = queryInfo?.players?.online ?? statusInfo?.players?.online ?? 0;
          const playersMax = queryInfo?.players?.max ?? statusInfo?.players?.max ?? 'unknown';
          const levelName = queryInfo?.map || 'unknown';
          const playerList = Array.isArray(queryInfo?.players?.list)
            ? queryInfo.players.list.join(', ')
            : Array.isArray(statusInfo?.players?.sample)
              ? statusInfo.players.sample.map((p) => p.name).join(', ')
              : '';
          const favicon = statusInfo?.favicon || null;
          const latency = statusInfo?.roundTripLatency;
          const srvRecord = queryInfo?.srvRecord || statusInfo?.srvRecord;

          const maxFieldLen = 1024;
          const truncatedPlayerList = playerList
            ? (playerList.length > maxFieldLen ? playerList.slice(0, maxFieldLen - 3) + '...' : playerList)
            : '';

          const fields = [
            { name: 'Status', value: isOnline ? 'Online' : 'Offline', inline: true },
            { name: 'Server', value: `${host}:${port}`, inline: true },
            { name: 'Version', value: String(version), inline: true },
            { name: 'Level Name', value: String(levelName), inline: true },
            { name: 'Players', value: `${playersOnline}/${playersMax}`, inline: true },
          ];

          if (truncatedPlayerList) fields.push({ name: 'Online Players', value: truncatedPlayerList, inline: false });
          if (latency !== undefined) fields.push({ name: 'Latency', value: `${latency} ms`, inline: true });
          if (srvRecord) fields.push({ name: 'SRV', value: `${srvRecord.host}:${srvRecord.port}`, inline: true });

          const embed = {
            title: 'Create SMP Server Status',
            color,
            fields,
            timestamp: new Date().toISOString(),
          };

          if (favicon) embed.thumbnail = { url: 'attachment://favicon.png' };
          if (!isOnline) embed.description = timeoutHit ? 'Server offline or timed out' : 'Server offline';

          return embed;
        };

        const sendOriginalResponse = async (embed, favicon) => {
          const url = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}/messages/@original`;

          if (favicon) {
            const base64 = favicon.includes(',') ? favicon.split(',')[1] : favicon;
            const imageBuffer = Buffer.from(base64, 'base64');
            const formData = new FormData();
            formData.append('payload_json', JSON.stringify({ embeds: [embed] }));
            formData.append('files[0]', new Blob([imageBuffer], { type: 'image/png' }), 'favicon.png');

            const response = await fetch(url, {
              method: 'PATCH',
              body: formData,
            });

            if (!response.ok) {
              throw new Error(`Discord webhook update failed: ${response.status} ${await response.text()}`);
            }

            return;
          }

          const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
          });

          if (!response.ok) {
            throw new Error(`Discord webhook update failed: ${response.status} ${await response.text()}`);
          }
        };

        try {
          const mc = await import('minecraft-server-util');
          const queryFullFn = mc.queryFull || mc.default?.queryFull;
          const statusFn = mc.status || mc.default?.status;

          const lookupWithTimeout = (promise, timeoutMs) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Server lookup timed out')), timeoutMs)),
          ]);

          const [queryResult, statusResult] = await Promise.allSettled([
            typeof queryFullFn === 'function' ? lookupWithTimeout(queryFullFn(host, port, { timeout: 5000 }), 5000) : Promise.reject(new Error('queryFull unavailable')),
            typeof statusFn === 'function' ? lookupWithTimeout(statusFn(host, port, { timeout: 5000 }), 5000) : Promise.reject(new Error('status unavailable')),
          ]);

          const queryInfo = queryResult.status === 'fulfilled' ? queryResult.value : null;
          const statusInfo = statusResult.status === 'fulfilled' ? statusResult.value : null;
          const isOnline = Boolean(queryInfo || statusInfo);
          const embed = buildStatusEmbed(isOnline, queryInfo, statusInfo, false);

          await sendOriginalResponse(embed, statusInfo?.favicon || null);
        } catch (err) {
          console.error('smpstatus error', err);

          const embed = buildStatusEmbed(false, null, null, true);
          await sendOriginalResponse(embed, null);
        }
      };

      respondWithEmbed().catch((err) => console.error('smpstatus follow-up failed', err));

      return;
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
