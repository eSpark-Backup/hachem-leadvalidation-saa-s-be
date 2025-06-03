import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { logger } from '#utils';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the swagger YAML file
const swaggerPath = join(__dirname, '..', 'docs', 'swagger.yaml');

// Load Swagger specification from YAML file
let swaggerSpec;
try {
    if (fs.existsSync(swaggerPath)) {
        swaggerSpec = YAML.load(swaggerPath);
        logger.info('Swagger specification loaded from YAML file');
    } else {
        logger.warn('Swagger YAML file not found, creating minimal spec');
        swaggerSpec = {
            openapi: '3.0.0',
            info: {
                title: 'Lead Validation SaaS API',
                version: '1.0.0',
                description: 'Swagger YAML file not found. Please create docs/swagger.yaml'
            },
            paths: {}
        };
    }
} catch (error) {
    logger.error('Error loading Swagger YAML file:', error);
    swaggerSpec = {
        openapi: '3.0.0',
        info: {
            title: 'Lead Validation SaaS API',
            version: '1.0.0',
            description: 'Error loading swagger specification'
        },
        paths: {}
    };
}

// Setup Swagger UI middleware
export const setupSwagger = (app) => {
    // Check if we should expose the docs
    const isDevOrStaging = ['development', 'staging'].includes(process.env.NODE_ENV);

    if (isDevOrStaging) {
        logger.info('Setting up Swagger documentation at /api-docs');

        // Serve swagger docs
        app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
            explorer: true,
            customCss: `
                .swagger-ui .topbar { display: none }
                .swagger-ui .info { margin: 20px 0; }
                .swagger-ui .scheme-container { background: #f8f9fa; padding: 10px; margin: 10px 0; border-radius: 4px; }
            `,
            customSiteTitle: 'Lead Validation SaaS API Documentation',
            swaggerOptions: {
                persistAuthorization: true,
                displayRequestDuration: true,
                filter: true,
                showExtensions: true,
                showCommonExtensions: true,
                docExpansion: 'list',
                defaultModelsExpandDepth: 2,
                defaultModelExpandDepth: 2
            }
        }));

        // Serve swagger spec as JSON
        app.get('/api-docs.json', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.send(swaggerSpec);
        });

        // Serve swagger spec as YAML
        app.get('/api-docs.yaml', (req, res) => {
            res.setHeader('Content-Type', 'text/yaml');
            res.send(YAML.stringify(swaggerSpec, 2));
        });

        // Development endpoint to reload swagger spec
        if (process.env.NODE_ENV === 'development') {
            app.post('/api-docs/reload', (req, res) => {
                try {
                    if (fs.existsSync(swaggerPath)) {
                        swaggerSpec = YAML.load(swaggerPath);
                        logger.info('Swagger specification reloaded');
                        res.json({ success: true, message: 'Swagger specification reloaded' });
                    } else {
                        res.status(404).json({ success: false, message: 'Swagger YAML file not found' });
                    }
                } catch (error) {
                    logger.error('Error reloading Swagger YAML:', error);
                    res.status(500).json({ success: false, message: 'Error reloading swagger specification' });
                }
            });
        }
    } else {
        logger.info('Swagger documentation disabled in production mode');
    }
};