# Create SMP Bot

Discord bot that shows a live status message for a Minecraft server.

## Features
- `/smpstatus` posts a status embed (online/offline, IP, version, players) that refreshes every minute.
- Detects shutdowns within ~5 seconds and DMs the admins listed in `SERVER_ADMINS_USER_IDS`, plus a notice when the server is back online.
- **Authorize shutdown** button silences the warning for a planned shutdown; **Stop** ends tracking and deletes the message.

## Setup
1. `npm install`
2. Copy `.env.sample` to `.env` and fill in the values.
3. Register the slash command: `npm run register`
4. Start the bot: `npm start`
5. Set the app's **Interactions Endpoint URL** in the [Discord developer portal](https://discord.com/developers/applications) to `https://<your-host>/interactions` (default port `3000`).
