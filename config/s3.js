// config/s3.js
import AWS from 'aws-sdk';
import fs from 'fs';
import dotenv from 'dotenv';
import { logger } from '#utils';

dotenv.config();

const s3Config = {
    region: process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
};

// Add endpoint for MinIO or custom S3-compatible services
if (process.env.S3_ENDPOINT) {
    s3Config.endpoint = process.env.S3_ENDPOINT;
    s3Config.s3ForcePathStyle = true; // Required for MinIO
}

const s3 = new AWS.S3(s3Config);

const BUCKET = process.env.S3_BUCKET || 'lead-validation-bucket';

// Validate S3 configuration on startup
const validateS3Config = () => {
    const requiredVars = ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'];
    const missing = requiredVars.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        logger.warn('Missing S3 environment variables:', missing);
        logger.info('S3 uploads will fail until these are configured');
        return false;
    }

    logger.info('S3 configuration validated successfully', {
        region: s3Config.region,
        bucket: BUCKET,
        endpoint: s3Config.endpoint || 'AWS S3'
    });
    return true;
};

export async function uploadToS3(filePath, key) {
    try {
        if (!validateS3Config()) {
            throw new Error('S3 configuration is incomplete. Please check environment variables.');
        }

        const fileStream = fs.createReadStream(filePath);

        const params = {
            Bucket: BUCKET,
            Key: key,
            Body: fileStream,
            ContentType: 'application/json'
        };

        await s3.upload(params).promise();

        logger.info('File uploaded to S3 successfully', { key, bucket: BUCKET });
        return `s3://${BUCKET}/${key}`;
    } catch (error) {
        logger.error('S3 upload failed', {
            error: error.message,
            key,
            bucket: BUCKET,
            region: s3Config.region
        });
        throw new Error(`S3 upload failed: ${error.message}`);
    }
}

export async function downloadFromS3(key) {
    try {
        if (!validateS3Config()) {
            throw new Error('S3 configuration is incomplete. Please check environment variables.');
        }

        const params = {
            Bucket: BUCKET,
            Key: key
        };

        const data = await s3.getObject(params).promise();
        const content = data.Body.toString('utf-8');

        logger.info('File downloaded from S3 successfully', { key, bucket: BUCKET });
        return content;
    } catch (error) {
        logger.error('S3 download failed', {
            error: error.message,
            key,
            bucket: BUCKET,
            region: s3Config.region
        });
        throw new Error(`S3 download failed: ${error.message}`);
    }
}

export async function testS3Connection() {
    try {
        if (!validateS3Config()) {
            return false;
        }

        const params = {
            Bucket: BUCKET,
            Key: 'test-connection-key-that-does-not-exist'
        };

        try {
            await s3.getObject(params).promise();
        } catch (error) {
            if (error.code === 'NoSuchKey' || error.statusCode === 404) {
                logger.info('S3 connection test successful');
                return true;
            }
            throw error;
        }

        return true;
    } catch (error) {
        logger.error('S3 connection test failed', {
            error: error.message,
            region: s3Config.region,
            bucket: BUCKET
        });
        return false;
    }
}

export default {
    uploadToS3,
    downloadFromS3,
    testS3Connection
};
