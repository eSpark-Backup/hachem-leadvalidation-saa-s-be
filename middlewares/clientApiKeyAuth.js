// middleware/clientApiKeyAuth.js
import ClientApiKeys from '#models/clientApiKeys';
import { logger } from '#utils';

/**
 * Middleware to authenticate requests using client API keys
 * Expects API key in Authorization header: "Bearer ck_..."
 */
export const authenticateClientApiKey = async (req, res, next) => {
    try {
        // Check if Authorization header exists
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Client API key is required',
                error: 'MISSING_API_KEY'
            });
        }

        // Extract the API key
        const apiKey = authHeader.split(' ')[1];

        // Validate API key format for client keys
        if (!apiKey || !apiKey.startsWith('ck_') || apiKey.length !== 67) { // ck_ + 64 chars
            return res.status(401).json({
                success: false,
                message: 'Invalid client API key format',
                error: 'INVALID_API_KEY_FORMAT'
            });
        }

        // Get client IP address
        const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

        // Authenticate the API key
        const user = await ClientApiKeys.authenticateApiKey(apiKey, ipAddress);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or inactive client API key',
                error: 'INVALID_API_KEY'
            });
        }

        // Set user in request object (similar to JWT auth)
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            fullname: user.fullname,
            // Additional API key specific info
            clientId: user.clientId,
            keyId: user.keyId,
            keyName: user.keyName,
            authType: 'api_key'
        };

        // Log successful authentication (debug level)
        logger.debug('Client API key authentication successful', {
            clientId: user.clientId,
            keyName: user.keyName,
            ipAddress,
            userAgent: req.headers['user-agent']
        });

        next();
    } catch (error) {
        logger.error('Client API key authentication error', {
            error: error.message,
            stack: error.stack,
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });

        return res.status(500).json({
            success: false,
            message: 'Authentication service error',
            error: 'AUTH_SERVICE_ERROR'
        });
    }
};

/**
 * Middleware to ensure only clients can access endpoint
 * Must be used after authenticateClientApiKey
 */
export const requireClientRole = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required',
            error: 'NOT_AUTHENTICATED'
        });
    }

    if (req.user.role !== 'client') {
        return res.status(403).json({
            success: false,
            message: 'Client role required',
            error: 'INSUFFICIENT_PERMISSIONS'
        });
    }

    next();
};

/**
 * Rate limiting middleware for client API key usage
 * Prevents abuse of API keys
 */
export const rateLimitClientApiKey = (maxRequests = 300, windowMs = 60000) => { // 300 requests per minute default
    const requestCounts = new Map();

    return (req, res, next) => {
        if (!req.user || !req.user.keyId) {
            return next();
        }

        const keyId = req.user.keyId;
        const now = Date.now();
        const windowStart = now - windowMs;

        // Clean up old entries
        if (requestCounts.has(keyId)) {
            const requests = requestCounts.get(keyId);
            requestCounts.set(keyId, requests.filter(time => time > windowStart));
        }

        // Get current request count for this key
        const currentRequests = requestCounts.get(keyId) || [];

        if (currentRequests.length >= maxRequests) {
            logger.warn('Client API key rate limit exceeded', {
                keyId,
                keyName: req.user.keyName,
                clientId: req.user.clientId,
                requestCount: currentRequests.length,
                maxRequests,
                windowMs
            });

            return res.status(429).json({
                success: false,
                message: 'Rate limit exceeded',
                error: 'RATE_LIMIT_EXCEEDED',
                retry_after: Math.ceil(windowMs / 1000)
            });
        }

        // Add current request
        currentRequests.push(now);
        requestCounts.set(keyId, currentRequests);

        next();
    };
};

/**
 * Flexible authentication middleware that accepts both JWT and API key
 * Used for endpoints that support both authentication methods
 */
export const authenticateClientFlexible = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                error: 'MISSING_AUTH_HEADER'
            });
        }

        const token = authHeader.split(' ')[1];

        // Check if it's a client API key (starts with ck_)
        if (token.startsWith('ck_')) {
            // Use API key authentication
            return authenticateClientApiKey(req, res, next);
        } else {
            // Use JWT authentication
            const { authenticate } = await import('#middleware/auth');
            return authenticate(req, res, next);
        }
    } catch (error) {
        logger.error('Flexible client authentication error', {
            error: error.message,
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            message: 'Authentication service error',
            error: 'AUTH_SERVICE_ERROR'
        });
    }
};