import { Worker } from 'bullmq';
import { downloadFromS3 } from './s3.js';
import Leads from '#controllers/leads';
import { connection } from './queue.js';

new Worker(
    'leadQueue',
    async job => {
        const { s3Key, clientId, threshold } = job.data;
        const content = await downloadFromS3(s3Key);
        const leads = JSON.parse(content);
        await Leads.processLeads(leads, clientId, threshold);
    },
    { connection }
);
