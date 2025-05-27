// config/database.js
import pg from 'pg';
import { logger } from '#utils';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

// Create a new pool instance
export const pool = new Pool(dbConfig);

// Error handling for the pool
pool.on('error', (err) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// Test database connection on startup
export const testConnection = async () => {
    let client;
    try {
        client = await pool.connect();
        logger.info('Successfully connected to PostgreSQL database');
    } catch (err) {
        logger.error('Failed to connect to the database', err);
        process.exit(1);
    } finally {
        if (client) client.release();
    }
};

// Execute SQL query with error handling
export const query = async (text, params = []) => {
    const start = Date.now();
    let client;

    try {
        client = await pool.connect();
        const result = await client.query(text, params);
        const duration = Date.now() - start;

        logger.debug('Executed query', {
            text,
            duration,
            rows: result.rowCount
        });

        return result;
    } catch (err) {
        logger.error('Database query error', {
            text,
            params,
            error: err.message
        });
        throw err;
    } finally {
        if (client) client.release();
    }
};

// Transaction helper
export const transaction = async (callback) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Transaction failed', err);
        throw err;
    } finally {
        client.release();
    }
};

export const db = {
    pool,
    query,
    transaction,
    testConnection
};