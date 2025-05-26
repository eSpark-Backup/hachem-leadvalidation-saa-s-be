// middleware/apiKeyAuth.js
import ApiKeys from '#models/apiKeys';
import { logger } from '#utils';

/**
 * Middleware to authenticate requests using API keys (for lead uploads only)
 * Expects API key in Authorization header: "Bearer sk_..."
 */
export const authenticateApiKey = async (req, res, next) => {
    try {
        // Check if Authorization header exists
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'API key is required',
                error: 'MISSING_API_KEY'
            });
        }

        // Extract the API key
        const apiKey = authHeader.split(' ')[1];

        // Validate API key format
        if (!apiKey || !apiKey.startsWith('sk_') || apiKey.length !== 67) { // sk_ + 64 chars
            return res.status(401).json({
                success: false,
                message: 'Invalid API key format',
                error: 'INVALID_API_KEY_FORMAT'
            });
        }

        // Get client IP address
        const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

        // Authenticate the API key
        const user = await ApiKeys.authenticateApiKey(apiKey, ipAddress);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or inactive API key',
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
            supplierId: user.supplierId,
            keyId: user.keyId,
            keyName: user.keyName,
            authType: 'api_key'
        };

        // Log successful authentication (debug level)
        logger.debug('API key authentication successful', {
            supplierId: user.supplierId,
            keyName: user.keyName,
            ipAddress,
            userAgent: req.headers['user-agent']
        });

        next();
    } catch (error) {
        logger.error('API key authentication error', {
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
 * Middleware to ensure only suppliers can access endpoint
 * Must be used after authenticateApiKey
 */
export const requireSupplierRole = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required',
            error: 'NOT_AUTHENTICATED'
        });
    }

    if (req.user.role !== 'supplier') {
        return res.status(403).json({
            success: false,
            message: 'Supplier role required',
            error: 'INSUFFICIENT_PERMISSIONS'
        });
    }

    next();
};

/**
 * Rate limiting middleware for API key usage
 * Prevents abuse of API keys
 */
export const rateLimitApiKey = (maxRequests = 100, windowMs = 60000) => { // 100 requests per minute default
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
            logger.warn('API key rate limit exceeded', {
                keyId,
                keyName: req.user.keyName,
                supplierId: req.user.supplierId,
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