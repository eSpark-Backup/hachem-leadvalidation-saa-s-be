// middleware/swaggerMiddleware.js
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import {logger} from '#utils';

// Swagger definition
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Lead Validation & Certification SaaS API',
            version: '1.0.0',
            description: 'API documentation for Lead Validation & Certification SaaS Platform',
            contact: {
                name: 'API Support',
                email: 'support@klairn.com'
            }
        },
        servers: [
            {
                url: '/',
                description: 'API server'
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT'
                }
            }
        },
        tags: [
            {
                name: 'Authentication',
                description: 'User authentication endpoints'
            },
            {
                name: 'Leads',
                description: 'Lead management endpoints'
            },
            {
                name: 'Users',
                description: 'User management endpoints'
            }
        ]
    },
    apis: [
        './routes/*.js',
        './models/*.js'
    ]
};

// Initialize swagger-jsdoc
const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Setup Swagger UI middleware
export const setupSwagger = (app) => {
    // Check if we should expose the docs
    const isDevOrStaging = ['development', 'staging'].includes(process.env.NODE_ENV);

    if (isDevOrStaging) {
        logger.info('Setting up Swagger documentation at /api-docs');

        // Serve swagger docs
        app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
            explorer: true,
            customCss: '.swagger-ui .topbar { display: none }',
            customSiteTitle: 'Klairn API Documentation'
        }));

        // Serve swagger spec as JSON
        app.get('/api-docs.json', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.send(swaggerSpec);
        });
    } else {
        logger.info('Swagger documentation disabled in production mode');
    }
};