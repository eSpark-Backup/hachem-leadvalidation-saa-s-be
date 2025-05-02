// middleware/authMiddleware.js
import { authService } from '#services/authService';
import { logger } from '#utils';

/**
 * Middleware to authenticate requests using JWT
 * Extracts bearer token from Authorization header
 */
export const authenticate = async (req, res, next) => {
    try {
        // Check if Authorization header exists
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Access token is required'
            });
        }

        // Extract the token
        const token = authHeader.split(' ')[1];

        // Verify the token
        const verification = authService.verifyToken(token, 'access');

        if (!verification.valid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired access token'
            });
        }

        // Set user in request object
        req.user = {
            id: verification.decoded.sub,
            email: verification.decoded.email,
            role: verification.decoded.role
        };

        next();
    } catch (error) {
        logger.error('Authentication error', error);
        return res.status(500).json({
            success: false,
            message: 'Authentication failed'
        });
    }
};

/**
 * Middleware to restrict access based on user role
 * @param {string[]} roles - Array of allowed roles
 */
export const authorize = (roles = []) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Convert single role to array
        const allowedRoles = Array.isArray(roles) ? roles : [roles];

        // Allow if roles array is empty (any authenticated user)
        if (allowedRoles.length === 0) {
            return next();
        }

        // Check if user has required role
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions'
            });
        }

        next();
    };
};