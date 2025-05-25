import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: false, // for MinIO
});

const BUCKET = process.env.S3_BUCKET;

async function uploadToS3(filePath, key) {
    const body = fs.createReadStream(filePath);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
    return `s3://${BUCKET}/${key}`;
}

async function downloadFromS3(key) {
    const { Body } = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    return Body.transformToString(); // auto converts stream to text
}

module.exports = { uploadToS3, downloadFromS3 };
