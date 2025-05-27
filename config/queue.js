import { Queue } from 'bullmq';
import dotenv from 'dotenv';
dotenv.config();

export const connection = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
};

export const leadQueue = new Queue('leadQueue', { connection });