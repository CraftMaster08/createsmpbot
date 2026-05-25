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
gatewayClient.once('ready', setPresenceOnReady);
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

      try {
        const mc = await import('minecraft-server-util');
        // support different module shapes
        const statusFn = mc.status || mc.default?.status || mc.default || mc;
        const info = await statusFn(host, port, { timeout: 5000 });

        const motd = (info.motd && (info.motd.clean || info.motd.raw)) || 'unknown';
        const version = info.version?.name || info.version || 'unknown';
        const players = info.players?.online ?? info.online ?? 0;
        const maxplayers = info.players?.max ?? info.max ?? 'unknown';
        const playerList = Array.isArray(info.players?.sample) ? info.players.sample.map(p => p.name).join(', ') : '';

        const content = `Server: ${host}:${port}\nMOTD: ${motd}\nVersion: ${version}\nPlayers: ${players}/${maxplayers}` + (playerList ? `\nOnline: ${playerList}` : '');

        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content },
        });
      } catch (err) {
        console.error('smpstatus error', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `Unable to reach server at ${host}:${port}.` },
        });
      }
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
