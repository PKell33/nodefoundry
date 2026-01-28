import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    path: process.env.DATABASE_PATH || join(__dirname, '../../data/nodefoundry.sqlite'),
  },

  paths: {
    data: process.env.DATA_PATH || join(__dirname, '../../data'),
    apps: process.env.APPS_PATH || join(__dirname, '../../data/apps'),
    appDefinitions: process.env.APP_DEFINITIONS_PATH || join(__dirname, '../../../app-definitions'),
    logs: process.env.LOGS_PATH || join(__dirname, '../../logs'),
  },

  secrets: {
    key: process.env.SECRETS_KEY || '',
  },
};

export type Config = typeof config;
