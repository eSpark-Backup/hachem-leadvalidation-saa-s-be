import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // 2 seconds

async function createPool() {
    const pool = new pg.Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        connectionTimeoutMillis: 10000, // 10 seconds
        max: 1,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    // Test the connection
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            logger.info(`Attempting database connection (attempt ${i + 1}/${MAX_RETRIES})`);
            const client = await pool.connect();
            client.release();
            logger.info('Successfully connected to database');
            return pool;
        } catch (error) {
            if (i === MAX_RETRIES - 1) {
                logger.error('Failed to connect to database after maximum retries', {
                    error: error.message,
                    stack: error.stack
                });
                throw new Error(`Database connection failed: ${error.message}`);
            }
            logger.warn(`Connection attempt failed, retrying in ${RETRY_DELAY/1000} seconds...`, {
                attempt: i + 1,
                error: error.message
            });
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
}

export async function initializeMigrations(pool) {
    logger.info('Initializing migrations table');
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        logger.info('Migrations table initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize migrations table', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

export async function runMigrations() {
    let pool;
    try {
        pool = await createPool();

        await initializeMigrations(pool);

        const migrationsDir = path.join(__dirname, '../migrations');
        const files = await fs.readdir(migrationsDir);
        const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

        logger.info('Found migration files', { count: sqlFiles.length });

        const { rows: executedMigrations } = await pool.query(
            'SELECT name FROM migrations'
        );
        const executedFiles = new Set(executedMigrations.map(m => m.name));

        for (const file of sqlFiles) {
            if (!executedFiles.has(file)) {
                logger.info(`Starting migration: ${file}`);

                // Read and execute migration
                const filePath = path.join(migrationsDir, file);
                const sql = await fs.readFile(filePath, 'utf-8');

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    logger.debug(`Executing SQL for ${file}`, { sqlLength: sql.length });
                    await client.query(sql);

                    await client.query(
                        'INSERT INTO migrations (name) VALUES ($1)',
                        [file]
                    );

                    await client.query('COMMIT');
                    logger.info(`Completed migration: ${file}`);
                } catch (error) {
                    await client.query('ROLLBACK');
                    logger.error(`Migration failed for ${file}`, {
                        error: error.message,
                        stack: error.stack
                    });
                    throw error;
                } finally {
                    client.release();
                }
            } else {
                logger.debug(`Skipping already executed migration: ${file}`);
            }
        }

        logger.info('All migrations completed successfully');
    } catch (error) {
        logger.error('Migration system error', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    } finally {
        if (pool) {
            logger.info('Closing database pool');
            await pool.end();
        }
    }
}

export async function checkDatabaseConnection() {
    let pool;
    try {
        pool = await createPool();
        logger.info('Database connection check successful');
        return true;
    } catch (error) {
        logger.error('Database connection check failed', {
            error: error.message,
            stack: error.stack
        });
        return false;
    } finally {
        if (pool) {
            await pool.end();
        }
    }
}