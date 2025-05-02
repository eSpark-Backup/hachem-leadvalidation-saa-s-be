// init/database.js
import {testConnection} from '#config';
import {migrationService} from '#services';
import {logger} from '#utils';

/**
 * Initialize the database
 * 1. Test the connection
 * 2. Run pending migrations
 */
export async function initializeDatabase() {
    try {
        // Test the database connection
        await testConnection();

        // Run pending migrations
        logger.info('Checking for pending migrations...');
        await migrationService.runMigrations();

        logger.info('Database initialization completed successfully');
        return true;
    } catch (error) {
        logger.error('Database initialization failed', error);
        return false;
    }
}
