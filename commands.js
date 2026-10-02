import 'dotenv/config';
import { InstallGlobalCommands, InstallGuildCommands } from './utils.js';

// SMP status command
const SMPSTATUS_COMMAND = {
  name: 'smpstatus',
  description: 'Get SMP server status',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [SMPSTATUS_COMMAND];

//InstallGlobalCommands(process.env.APP_ID, []);
InstallGuildCommands(process.env.APP_ID, process.env.GUILD_ID, ALL_COMMANDS);
