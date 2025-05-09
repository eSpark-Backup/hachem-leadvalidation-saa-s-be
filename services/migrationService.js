// services/migrationService.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import {pool as db} from '#config';
import {logger} from '#utils';

// Get current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = path.join(__dirname, '..', 'migrations');

// Ensure the migrations directory exists
if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    logger.info(`Created migrations directory at ${migrationsDir}`);
}

class MigrationService {
    // Initialize migrations table if it doesn't exist
    async initMigrationsTable() {
        const checkTableQuery = `
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename = 'migrations'
      );
    `;

        const tableExists = await db.query(checkTableQuery);

        if (!tableExists.rows[0].exists) {
            logger.info('Migrations table does not exist. Creating it now...');

            const createTableQuery = `
        CREATE TABLE migrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          checksum VARCHAR(64) NOT NULL
        );
      `;

            await db.query(createTableQuery);
            logger.info('Migrations table created successfully');
        }
    }

    // Get all migration files from the migrations directory
    getMigrationFiles() {
        try {
            // Read all files from migrations directory
            const files = fs.readdirSync(migrationsDir)
                .filter(file => file.endsWith('.sql'))
                .sort(); // Ensure files are processed in alphabetical order

            return files;
        } catch (err) {
            logger.error('Error reading migration files', err);
            throw err;
        }
    }

    // Get already applied migrations from the database
    async getAppliedMigrations() {
        try {
            const query = 'SELECT name, checksum FROM migrations ORDER BY id';
            const result = await db.query(query);

            // Create a map of migration name to checksum for easier lookup
            const migrations = new Map();
            result.rows.forEach(row => {
                migrations.set(row.name, row.checksum);
            });

            return migrations;
        } catch (err) {
            logger.error('Error fetching applied migrations', err);
            throw err;
        }
    }

    // Calculate a simple checksum for a file
    calculateChecksum(content) {
        const hash = crypto.createHash('sha256');
        hash.update(content);
        return hash.digest('hex');
    }

    // Run a specific migration
    async runMigration(migrationName, client = null) {
        const migrationPath = path.join(migrationsDir, migrationName);

        try {
            // Read the migration file
            const migrationContent = fs.readFileSync(migrationPath, 'utf8');
            const checksum = this.calculateChecksum(migrationContent);

            logger.info(`Running migration: ${migrationName}`);

            // If client is provided, use it (we're in a transaction)
            // Otherwise, run the query directly
            if (client) {
                logger.info(`Client found`)
                // Execute migration
                await client.query(migrationContent);

                // Record the migration
                await client.query(
                    'INSERT INTO migrations (name, checksum) VALUES ($1, $2)',
                    [migrationName, checksum]
                );
            } else {
                logger.info(`Client not found`)

                // Use transaction to ensure both migration and record are atomic
                await db.transaction(async (transactionClient) => {
                    logger.info(`Running migration content`)
                    // Execute migration
                    await transactionClient.query(migrationContent);
                    logger.info(`Ran migration content`)

                    // Record the migration
                    await transactionClient.query(
                        'INSERT INTO migrations (name, checksum) VALUES ($1, $2)',
                        [migrationName, checksum]
                    );
                });
            }

            logger.info(`Successfully applied migration: ${migrationName}`);
            return true;
        } catch (err) {
            logger.error(`Failed to apply migration: ${migrationName}`, err);
            throw err;
        }
    }

    // Check for changes in already applied migrations
    async checkForChanges(files, appliedMigrations) {
        for (const file of files) {
            // If the migration has already been applied
            if (appliedMigrations.has(file)) {
                const storedChecksum = appliedMigrations.get(file);
                const currentContent = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
                const currentChecksum = this.calculateChecksum(currentContent);

                // If the checksums don't match, the migration file has been modified
                if (storedChecksum !== currentChecksum) {
                    logger.warn(`Migration ${file} has been modified after being applied!`);
                    // You could throw an error here if you want to prevent startup
                    // throw new Error(`Migration ${file} has been modified after being applied!`);
                }
            }
        }
    }

    // Run all pending migrations
    async runMigrations() {
        let client = null;
        try {
            client = await pool.connect()
            // Ensure migrations table exists
            await this.initMigrationsTable();

            // Get migration files and applied migrations
            const files = this.getMigrationFiles();
            const appliedMigrations = await this.getAppliedMigrations();

            // Check for changes in applied migrations
            await this.checkForChanges(files, appliedMigrations);

            // Filter out migrations that have already been applied
            const pendingMigrations = files.filter(file => !appliedMigrations.has(file));

            if (pendingMigrations.length === 0) {
                logger.info('No pending migrations to apply');
                return;
            }

            logger.info(`Found ${pendingMigrations.length} pending migrations`);

            // Run each pending migration in a separate transaction
            for (const migration of pendingMigrations) {
                await this.runMigration(migration, client);
            }

            logger.info('All migrations applied successfully');
        } catch (err) {
            logger.error('Error running migrations', err);
            throw err;
        } finally {
            if (client){
                client.release()
            }
        }
    }

    // Create a new empty migration file
    createMigrationFile(name) {
        // Format: timestamp_name.sql
        const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').substring(0, 14);
        const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const filename = `${timestamp}_${safeName}.sql`;
        const filepath = path.join(migrationsDir, filename);

        // Create template content for the migration
        const template = `-- Migration: ${name}
-- Created at: ${new Date().toISOString()}

-- Write your SQL here

-- For example:
-- CREATE TABLE example (
--   id SERIAL PRIMARY KEY,
--   name VARCHAR(255) NOT NULL,
--   created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
-- );

-- Don't forget to add down migrations as comments for reference:
-- -- Down migration:
-- -- DROP TABLE example;
`;

        fs.writeFileSync(filepath, template);
        logger.info(`Created new migration file: ${filename}`);
        return filename;
    }
}

export const migrationService = new MigrationService()

export default new MigrationService();