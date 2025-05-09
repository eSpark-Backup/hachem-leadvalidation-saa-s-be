#!/usr/bin/env node
// scripts/create-migration.js
import {fileURLToPath} from 'url';
import path, {dirname} from 'path';
import migrationService from '../services/migrationService.js';

// Get current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Function to show usage information
function showUsage() {
    console.log(`
Usage: node create-migration.js <migration-name>

Creates a new SQL migration file in the migrations directory.

Examples:
  node create-migration.js create_users_table
  node create-migration.js "Add email index to users"
  `);
}

// Main function
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        showUsage();
        process.exit(0);
    }

    const migrationName = args[0];

    try {
        const filename = migrationService.createMigrationFile(migrationName);
        console.log(`✅ Migration file created: ${filename}`);
        console.log(`📝 Edit the file at: ${path.join(projectRoot, 'migrations', filename)}`);
    } catch (error) {
        console.error(`❌ Error creating migration: ${error.message}`);
        process.exit(1);
    }
}

// Run the main function
main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});