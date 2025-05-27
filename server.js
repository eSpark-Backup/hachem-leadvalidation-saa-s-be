// server.js
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();
import cors from 'cors';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { logger } from '#utils';
import { initializeDatabase } from '#init';
import { authRoutes } from '#routes';
import leadsRouter from '#routes/leads'
import clientRouter from '#routes/client'
import apiKeysRouter from '#routes/apiKeys'
import { setupSwagger } from '#middleware';
import {runMigrations} from "#utils/migrate";
import {testConnection} from "#config";

// Load environment variables

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;
await testConnection();
await runMigrations();

// Security middleware
app.use(helmet());

// CORS middleware with options
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Parse request bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Parse cookies
app.use(cookieParser());

// Simple routes for testing
app.get('/', (req, res) => {
    res.json({ message: 'Lead Validation SaaS API is running' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRouter);
app.use('/api/client', clientRouter);
app.use('/api/api-keys', apiKeysRouter);

// Setup Swagger documentation (only in dev/staging)
setupSwagger(app);

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
});

// Start server function
async function startServer() {
    try {
        // Start Express server
        app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

            if (['development', 'staging'].includes(process.env.NODE_ENV)) {
                logger.info(`API Documentation: http://localhost:${PORT}/api-docs`);
            }
        });
    } catch (error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
}

// Start the server
startServer();

export default app;