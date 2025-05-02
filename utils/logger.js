// utils/logger.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logsDir = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Log levels
const LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

// Get current log level from environment or default to INFO
const currentLevel = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] || LEVELS.INFO;

// Create date-based log filename
const getLogFilename = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return path.join(logsDir, `${year}-${month}-${day}.log`);
};

// Format log message
const formatMessage = (level, message, meta) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}\n`;
};

// Write to log file
const writeToLog = (level, message, meta = null) => {
    const logFile = getLogFilename();
    const formattedMessage = formatMessage(level, message, meta);

    // Write to console
    switch (level) {
        case 'ERROR':
            console.error(formattedMessage);
            break;
        case 'WARN':
            console.warn(formattedMessage);
            break;
        case 'INFO':
            console.info(formattedMessage);
            break;
        case 'DEBUG':
            console.debug(formattedMessage);
            break;
        default:
            console.log(formattedMessage);
    }

    // Write to file
    fs.appendFileSync(logFile, formattedMessage);
};

// Logger methods
export const logger = {
    error: (message, meta) => {
        if (currentLevel >= LEVELS.ERROR) {
            writeToLog('ERROR', message, meta);
        }
    },

    warn: (message, meta) => {
        if (currentLevel >= LEVELS.WARN) {
            writeToLog('WARN', message, meta);
        }
    },

    info: (message, meta) => {
        if (currentLevel >= LEVELS.INFO) {
            writeToLog('INFO', message, meta);
        }
    },

    debug: (message, meta) => {
        if (currentLevel >= LEVELS.DEBUG) {
            writeToLog('DEBUG', message, meta);
        }
    },

    // Log and return a value - useful for debugging in the middle of a chain
    tap: (message, value) => {
        if (currentLevel >= LEVELS.DEBUG) {
            writeToLog('DEBUG', message, value);
        }
        return value;
    }
};

export default logger;