// config/worker.js - Updated to remove threshold parameter
import { Worker } from 'bullmq';
import { connection } from './queue.js';
import Leads from '#models/leads';
import { logger } from '#utils';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine storage type and import appropriate module
const useLocalStorage = process.env.USE_LOCAL_STORAGE === 'true' ||
    !process.env.S3_ACCESS_KEY ||
    !process.env.AWS_REGION;

let downloadFromStorage;

if (useLocalStorage) {
    logger.info('Using local storage for worker (S3 not configured)');

    // Local storage implementation directly in worker
    const STORAGE_DIR = process.env.LOCAL_STORAGE_PATH || path.join(__dirname, '..', 'storage', 'uploads');

    // Ensure storage directory exists
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        logger.info(`Created storage directory: ${STORAGE_DIR}`);
    }

    downloadFromStorage = async (key) => {
        try {
            const filePath = path.join(STORAGE_DIR, key);

            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found in local storage: ${key}`);
            }

            const content = fs.readFileSync(filePath, 'utf8');
            logger.info('File downloaded from local storage successfully', { key });
            return content;
        } catch (error) {
            logger.error('Local storage download failed', { error: error.message, key });
            throw new Error(`Local storage download failed: ${error.message}`);
        }
    };
} else {
    logger.info('Using S3 storage for worker');

    try {
        // Dynamic import for S3
        const s3Module = await import('./s3.js');
        downloadFromStorage = s3Module.downloadFromS3;
    } catch (error) {
        logger.error('Failed to import S3 module:', error);
        throw new Error('S3 configuration failed: ' + error.message);
    }
}

const worker = new Worker(
    'leadQueue',
    async (job) => {
        // FIXED: Removed threshold from job data - it's now determined by client settings
        const { uploadId, s3Key, clientId, supplierId } = job.data;

        try {
            logger.info(`Starting processing for upload ${uploadId}`, {
                uploadId,
                clientId,
                supplierId,
                storageType: useLocalStorage ? 'local' : 's3'
            });

            // Update job progress
            await job.updateProgress(10);

            // Update upload status to processing
            await Leads.updateUploadStatus(uploadId, 'processing', {
                processed_leads: 0,
                valid_leads: 0
            });

            // Download file from storage
            logger.info(`Downloading file from storage: ${s3Key}`);
            const content = await downloadFromStorage(s3Key);
            await job.updateProgress(30);

            // Parse JSON content
            let jsonData;
            try {
                jsonData = JSON.parse(content);
                logger.info('JSON parsed successfully', {
                    type: Array.isArray(jsonData) ? 'array' : 'object',
                    hasLeadsProperty: !!jsonData.leads
                });
            } catch (error) {
                logger.error('JSON parse error:', error);
                throw new Error(`Invalid JSON file: ${error.message}`);
            }

            // Extract leads array
            let leads;
            if (Array.isArray(jsonData)) {
                leads = jsonData;
            } else if (jsonData.leads && Array.isArray(jsonData.leads)) {
                leads = jsonData.leads;
            } else {
                logger.error('Invalid JSON structure:', {
                    isArray: Array.isArray(jsonData),
                    hasLeads: !!jsonData.leads,
                    leadsIsArray: Array.isArray(jsonData.leads),
                    keys: Object.keys(jsonData || {})
                });
                throw new Error('JSON must contain an array of leads or an object with "leads" property');
            }

            if (leads.length === 0) {
                throw new Error('No leads found in the uploaded file');
            }

            logger.info('Leads extracted successfully', {
                count: leads.length,
                firstLead: leads[0] ? Object.keys(leads[0]) : 'no leads'
            });

            await job.updateProgress(50);

            // Process leads - threshold is now determined inside processLeads from client settings
            logger.info('Starting lead processing...');
            const result = await Leads.processLeads(uploadId, leads, clientId, supplierId);

            await job.updateProgress(100);

            logger.info(`Completed processing for upload ${uploadId}`, result);

            return {
                success: true,
                uploadId,
                ...result
            };

        } catch (error) {
            logger.error(`Failed to process upload ${uploadId}`, {
                uploadId,
                error: error.message,
                stack: error.stack
            });

            // Update upload status to failed
            try {
                await Leads.updateUploadStatus(uploadId, 'failed', {
                    error_message: error.message
                });
                logger.info(`Updated upload ${uploadId} status to failed`);
            } catch (updateError) {
                logger.error(`Failed to update upload ${uploadId} status:`, updateError);
            }

            throw error;
        }
    },
    {
        connection,
        concurrency: 2, // Reduced concurrency for debugging
        removeOnComplete: 10, // Keep last 10 completed jobs
        removeOnFail: 20, // Keep last 20 failed jobs
        attempts: 3, // Retry failed jobs up to 3 times
        backoff: {
            type: 'exponential',
            delay: 2000,
        }
    }
);

// Worker event handlers
worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed successfully`, {
        jobId: job.id,
        uploadId: job.data.uploadId,
        duration: job.finishedOn ? job.finishedOn - job.processedOn : 'unknown'
    });
});

worker.on('failed', (job, err) => {
    logger.error(`Job ${job.id} failed`, {
        jobId: job.id,
        uploadId: job.data?.uploadId,
        error: err.message,
        attempts: job?.attemptsMade || 0,
        maxAttempts: job?.opts?.attempts || 1
    });
});

worker.on('progress', (job, progress) => {
    logger.debug(`Job ${job.id} progress: ${progress}%`, {
        jobId: job.id,
        uploadId: job.data?.uploadId,
        progress
    });
});

worker.on('error', (err) => {
    logger.error('Worker error', err);
});

worker.on('ready', () => {
    logger.info('Worker is ready and waiting for jobs');
});

worker.on('closing', () => {
    logger.info('Worker is closing...');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down worker gracefully...');
    await worker.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down worker gracefully...');
    await worker.close();
    process.exit(0);
});

logger.info('Lead processing worker started and ready for jobs');

export default worker;