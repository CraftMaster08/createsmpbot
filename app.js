import 'dotenv/config';
import express from 'express';
import net from 'node:net';
import {
  InteractionResponseType,
  InteractionType,
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
const statusSessions = new Map();

const STATUS_REFRESH_INTERVAL_MS = 60 * 1000;
const STATUS_CHECK_INTERVAL_MS = 5 * 1000;

function getStatusSession(stateId) {
  return statusSessions.get(stateId) || null;
}

const MOTD_COLOR_MAP = new Map([
  ['#000000', '30'],
  ['#0000aa', '34'],
  ['#00aa00', '32'],
  ['#00aaaa', '36'],
  ['#aa0000', '31'],
  ['#aa00aa', '35'],
  ['#ffaa00', '33'],
  ['#aaaaaa', '90'],
  ['#555555', '90'],
  ['#5555ff', '94'],
  ['#ff5555', '91'],
  ['#ff55ff', '95'],
  ['#55ffff', '96'],
  ['#ffffff', '97'],
  ['#55ff55', '92'],
  ['#ffff55', '93'],
]);

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeColor(colorValue) {
  if (!colorValue) return null;
  return MOTD_COLOR_MAP.get(colorValue.toLowerCase()) || null;
}

function parseSpanStyle(tagText) {
  const styleMatch = tagText.match(/style\s*=\s*"([^"]+)"/i);
  const styleText = styleMatch ? styleMatch[1].toLowerCase() : '';
  const colorMatch = styleText.match(/color:\s*(#[0-9a-f]{6})/i);
  return {
    bold: /font-weight:\s*bold/.test(styleText),
    color: normalizeColor(colorMatch?.[1] || null),
  };
}

function ansiFromStyle(style) {
  const codes = [];
  if (style.bold) codes.push('1');
  if (style.color) codes.push(style.color);
  return codes.length ? `\u001b[${codes.join(';')}m` : '';
}

function buildWidgetImageUrl(statusInfo, widgetUrl) {
  const cacheBuster = statusInfo?.retrieved_at || Date.now();
  return `${widgetUrl}${widgetUrl.includes('?') ? '&' : '?'}v=${cacheBuster}`;
}

function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_~|])/g, '\\$1');
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractPlayerNames(players) {
  if (!Array.isArray(players)) return [];

  return [...new Set(players.map((player) => {
    if (typeof player === 'string') return player;
    return player?.name_clean || player?.name_raw || player?.name || '';
  }).filter(Boolean))];
}

function formatPlayerList(players) {
  if (!players.length) return 'No player names were returned by the API.';

  const visiblePlayers = players.slice(0, 20).map((player) => `• ${escapeMarkdown(player)}`);
  if (players.length > 20) {
    visiblePlayers.push(`• ...and ${players.length - 20} more`);
  }

  return truncateText(visiblePlayers.join('\n'), 1024);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timed out: ${url}`)), timeoutMs)),
  ]);
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000, options = {}) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function probeMinecraftServer(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function createOfflineStatusInfo(session) {
  return {
    online: false,
    ip_address: session.host,
    retrieved_at: Date.now(),
    players: { online: 0, max: 'unknown', list: [] },
    version: { name_clean: 'unknown', name_raw: 'unknown' },
  };
}

function createOnlineStatusInfo(session, detailedStatus = null) {
  return {
    online: true,
    ip_address: session.host,
    retrieved_at: detailedStatus?.retrieved_at || Date.now(),
    players: detailedStatus?.players || { online: 0, max: 'unknown', list: [] },
    version: detailedStatus?.version || { name_clean: 'unknown', name_raw: 'unknown' },
  };
}

function isSnowflake(value) {
  return /^\d{15,20}$/.test(String(value).trim());
}

function getAdminUserIds() {
  const configuredIds = process.env.SERVER_ADMINS_USER_IDS || '';
  return [...new Set(configuredIds.split(',').map((id) => id.trim()).filter(isSnowflake))];
}

function getInteractionUserId(body) {
  return body?.member?.user?.id || body?.user?.id || null;
}

function buildStatusComponents(session) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: 'Stop',
          custom_id: `smpstatus:stop:${session.stateId}`,
        },
        {
          type: 2,
          style: 3,
          label: 'Authorize shutdown',
          custom_id: `smpstatus:authorize:${session.stateId}`,
          disabled: Boolean(session.shutdownAuthorized),
        },
      ],
    },
  ];
}

function buildShutdownWarningEmbed(statusInfo, host, port) {
  const playersOnline = statusInfo?.players?.online ?? 0;
  const playersMax = statusInfo?.players?.max ?? 'unknown';
  const version = statusInfo?.version?.name_clean || statusInfo?.version?.name_raw || 'unknown';
  const ipAddress = statusInfo?.ip_address || host;
  const addressLine = `${ipAddress}:${port}`;

  return {
    title: 'Server shutdown warning',
    color: 0xed4245,
    description: 'The server is offline and shutdown was not authorized.',
    fields: [
      { name: 'Status', value: 'Offline', inline: true },
      { name: 'IP', value: `\`${addressLine}\``, inline: true },
      { name: 'Version', value: version, inline: true },
      { name: 'Player Count', value: `${playersOnline}/${playersMax}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

function buildStartupNoticeEmbed(statusInfo, host, port) {
  const playersOnline = statusInfo?.players?.online ?? 0;
  const playersMax = statusInfo?.players?.max ?? 'unknown';
  const version = statusInfo?.version?.name_clean || statusInfo?.version?.name_raw || 'unknown';
  const ipAddress = statusInfo?.ip_address || host;
  const addressLine = `${ipAddress}:${port}`;

  return {
    title: 'Server is back online',
    color: 0x3ba55d,
    description: 'The server is running again. Status tracking has resumed.',
    fields: [
      { name: 'Status', value: 'Online', inline: true },
      { name: 'IP', value: `\`${addressLine}\``, inline: true },
      { name: 'Version', value: version, inline: true },
      { name: 'Player Count', value: `${playersOnline}/${playersMax}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

async function sendShutdownWarningToAdmins(session, statusInfo) {
  const adminUserIds = getAdminUserIds();
  if (!adminUserIds.length) {
    console.warn('Shutdown warning skipped: no SERVER_ADMINS_USER_IDS configured');
    return;
  }

  const warningEmbed = buildShutdownWarningEmbed(statusInfo, session.host, session.port);
  const warningMessage = {
    content: `Create SMP shutdown detected`,
    embeds: [warningEmbed],
  };

  const results = await Promise.allSettled(adminUserIds.map(async (userId) => {
    const channelResponse = await DiscordRequest('users/@me/channels', {
      method: 'POST',
      body: { recipient_id: userId },
    });

    const channelData = await channelResponse.json();
    await DiscordRequest(`channels/${channelData.id}/messages`, {
      method: 'POST',
      body: warningMessage,
    });
  }));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to send shutdown warning to admin ${adminUserIds[index]}`, result.reason);
    }
  });
}

async function sendStartupNoticeToAdmins(session, statusInfo) {
  const adminUserIds = getAdminUserIds();
  if (!adminUserIds.length) {
    return;
  }

  const noticeEmbed = buildStartupNoticeEmbed(statusInfo, session.host, session.port);
  const noticeMessage = {
    content: `Create SMP is back online`,
    embeds: [noticeEmbed],
  };

  const results = await Promise.allSettled(adminUserIds.map(async (userId) => {
    const channelResponse = await DiscordRequest('users/@me/channels', {
      method: 'POST',
      body: { recipient_id: userId },
    });

    const channelData = await channelResponse.json();
    await DiscordRequest(`channels/${channelData.id}/messages`, {
      method: 'POST',
      body: noticeMessage,
    });
  }));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to send startup notice to admin ${adminUserIds[index]}`, result.reason);
    }
  });
}

async function deleteOriginalMessage(token) {
  const url = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}/messages/@original`;
  const response = await fetch(url, { method: 'DELETE' });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Discord webhook delete failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

function clearStatusSession(stateId) {
  const session = getStatusSession(stateId);
  if (!session) return;

  if (session.refreshTimer) {
    clearTimeout(session.refreshTimer);
  }

  if (session.watchTimer) {
    clearTimeout(session.watchTimer);
  }

  statusSessions.delete(stateId);
}

function buildStatusEmbed(statusInfo, host, port, widgetUrl, errorMessage = null) {
  const isOnline = Boolean(statusInfo?.online);
  const playersOnline = statusInfo?.players?.online ?? 0;
  const playerNames = extractPlayerNames(statusInfo?.players?.list);
  const version = statusInfo?.version?.name_clean || statusInfo?.version?.name_raw || 'unknown';
  const ipAddress = statusInfo?.ip_address || host;
  const addressLine = `${ipAddress}:${port}`;
  const color = isOnline ? 0x3ba55d : 0xed4245;

  const fields = [
    { name: 'Status', value: isOnline ? 'Online' : 'Offline', inline: true },
    { name: 'IP', value: `\`${addressLine}\``, inline: true },
    { name: 'Version', value: version, inline: true },
    { name: 'Players', value: playerNames.length ? formatPlayerList(playerNames) : 'No player online', inline: false },
  ];

  const embed = {
    title: 'Create SMP Status',
    color,
    fields,
    footer: { text: 'Auto-refreshes every minute' },
    timestamp: new Date().toISOString(),
    image: { url: buildWidgetImageUrl(statusInfo, widgetUrl) },
  };

  if (!isOnline && errorMessage) {
    embed.description = errorMessage;
  }

  return embed;
}

async function buildStatusPayload(session, errorMessage = null) {
  return {
    embeds: [buildStatusEmbed(session.statusInfo, session.host, session.port, session.widgetUrl, errorMessage)],
    components: buildStatusComponents(session),
  };
}

function getStatusOnlineState(statusInfo) {
  return Boolean(statusInfo?.online);
}

async function refreshStatusSession(session, { forceUpdate = false } = {}) {
  if (session.statusRefreshPromise) {
    return session.statusRefreshPromise;
  }

  session.statusRefreshPromise = (async () => {
    const previousOnlineState = session.lastOnlineState;
    const isReachable = await probeMinecraftServer(session.host, session.port, 1000);
    let freshStatus;

    if (isReachable) {
      try {
        const detailedStatus = await fetchStatusInfo(session.statusUrl, 5000);
        freshStatus = createOnlineStatusInfo(session, detailedStatus);
      } catch (err) {
        console.error('smpstatus detailed status fetch failed, using online fallback', err);
        freshStatus = createOnlineStatusInfo(session);
      }
    } else {
      freshStatus = createOfflineStatusInfo(session);
    }

    const nextOnlineState = freshStatus.online;
    const stateChanged = previousOnlineState !== null && nextOnlineState !== previousOnlineState;
    const recovered = previousOnlineState === false && nextOnlineState === true;
    const wentOffline = previousOnlineState === true && nextOnlineState === false;

    session.statusInfo = freshStatus;
    session.lastOnlineState = nextOnlineState;

    if (recovered) {
      session.shutdownAuthorized = false;
    }

    const shouldUpdateMessage = forceUpdate || previousOnlineState === null || stateChanged || recovered || wentOffline;

    if (shouldUpdateMessage) {
      await updateStatusMessage(session);
    }

    if (wentOffline) {
      session.suppressStartupNotice = Boolean(session.shutdownAuthorized);

      if (!session.shutdownAuthorized) {
      sendShutdownWarningToAdmins(session, freshStatus).catch((err) => {
        console.error('failed to send shutdown warning', err);
      });
      }
    }

    if (recovered) {
      const suppressStartupNotice = Boolean(session.suppressStartupNotice);
      session.suppressStartupNotice = false;

      if (!suppressStartupNotice) {
        sendStartupNoticeToAdmins(session, freshStatus).catch((err) => {
          console.error('failed to send startup notice', err);
        });
      }
    }

    return { changed: stateChanged, recovered, wentOffline, nextOnlineState, fetchSucceeded: isReachable };
  })();

  try {
    return await session.statusRefreshPromise;
  } finally {
    session.statusRefreshPromise = null;
  }
}

async function updateStatusMessage(session, errorMessage = null) {
  await patchOriginalMessage(session.token, await buildStatusPayload(session, errorMessage));
}

function scheduleStatusRefresh(stateId, delayMs = STATUS_REFRESH_INTERVAL_MS) {
  const session = getStatusSession(stateId);
  if (!session) return;

  if (session.refreshTimer) {
    clearTimeout(session.refreshTimer);
  }

  session.refreshTimer = setTimeout(async () => {
    const activeSession = getStatusSession(stateId);
    if (!activeSession) return;

    try {
      await refreshStatusSession(activeSession, { forceUpdate: true });
    } catch (err) {
      console.error('smpstatus auto-refresh failed', err);
    } finally {
      scheduleStatusRefresh(stateId);
    }
  }, delayMs);
}

function scheduleStatusWatcher(stateId) {
  const session = getStatusSession(stateId);
  if (!session) return;

  if (session.watchTimer) {
    clearTimeout(session.watchTimer);
  }

  session.watchTimer = setTimeout(async () => {
    const activeSession = getStatusSession(stateId);
    if (!activeSession) return;

    try {
      await refreshStatusSession(activeSession);
    } catch (err) {
      console.error('smpstatus watch failed', err);
    } finally {
      scheduleStatusWatcher(stateId);
    }
  }, STATUS_CHECK_INTERVAL_MS);
}

async function fetchStatusInfo(statusUrl, timeoutMs = 5000) {
  return fetchJsonWithTimeout(statusUrl, timeoutMs, { headers: { Accept: 'application/json' } });
}

async function patchOriginalMessage(token, payload) {
  const url = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}/messages/@original`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook update failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

function scheduleAutoRefresh(stateId) {
  scheduleStatusRefresh(stateId);
  scheduleStatusWatcher(stateId);
}

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
      const stateId = req.body.id;
      const requesterId = getInteractionUserId(req.body);
      const serverAddress = `${host}:${port}`;
      const statusUrl = `https://api.mcstatus.io/v2/status/java/${serverAddress}`;
      const widgetUrl = `https://api.mcstatus.io/v2/widget/java/${serverAddress}`;

      // Acknowledge immediately so Discord doesn't time out the interaction.
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      const respondWithEmbed = async () => {
        try {
          const session = {
            stateId,
            token,
            requesterId,
            host,
            port,
            statusUrl,
            widgetUrl,
            statusInfo: await fetchStatusInfo(statusUrl),
            lastOnlineState: null,
            shutdownAuthorized: false,
            suppressStartupNotice: false,
            refreshTimer: null,
            watchTimer: null,
            statusRefreshPromise: null,
          };

          statusSessions.set(stateId, session);
          await refreshStatusSession(session, { forceUpdate: true });
          scheduleAutoRefresh(stateId);
        } catch (err) {
          console.error('smpstatus error', err);

          const session = {
            stateId,
            token,
            requesterId,
            host,
            port,
            statusUrl,
            widgetUrl,
            statusInfo: null,
            lastOnlineState: null,
            shutdownAuthorized: false,
            suppressStartupNotice: false,
            refreshTimer: null,
            watchTimer: null,
            statusRefreshPromise: null,
          };

          statusSessions.set(stateId, session);
          await patchOriginalMessage(token, await buildStatusPayload(session, 'Unable to reach the server right now.'));
          scheduleAutoRefresh(stateId);
        }
      };

      respondWithEmbed().catch((err) => console.error('smpstatus follow-up failed', err));

      return;
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const customId = data?.custom_id || '';
    const match = customId.match(/^smpstatus:(stop|authorize):(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'unknown component' });
    }

    const [, action, stateId] = match;
    const session = getStatusSession(stateId);
    const userId = getInteractionUserId(req.body);

    if (!session) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'This status tracker is no longer active.', flags: 64 },
      });
    }

    if (session.requesterId && userId && userId !== session.requesterId) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Only the command author can use these controls.', flags: 64 },
      });
    }

    if (action === 'stop') {
      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Stopped tracking and deleted the status message.', flags: 64 },
      });

      clearStatusSession(stateId);
      deleteOriginalMessage(session.token).catch((err) => {
        console.error('failed to delete status message', err);
      });
      return;
    }

    if (action === 'authorize') {
      session.shutdownAuthorized = true;

      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Shutdown authorized. Admin warnings will be suppressed until the server is back online.', flags: 64 },
      });

      await patchOriginalMessage(session.token, await buildStatusPayload(session));
      return;
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
