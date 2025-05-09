// middleware/validationMiddleware.js
import { logger } from '#utils';

/**
 * Middleware factory for validating request data against a Yup schema
 * @param {Object} schema - Yup schema to validate against
 * @param {String} source - Request property to validate ('body', 'query', 'params')
 * @returns {Function} Express middleware function
 */
export const validate = (schema, source = 'body') => {
    return async (req, res, next) => {
        try {
            // Get data from the specified request property
            const data = req[source];

            // Validate data against schema
            await schema.validate(data, { abortEarly: false });

            // Continue if validation passes
            next();
        } catch (error) {
            // If validation error, format error messages
            if (error.name === 'ValidationError') {
                const errors = {};

                // Convert Yup error to a more readable format
                error.inner.forEach(err => {
                    errors[err.path] = err.message;
                });

                return res.status(400).json({
                    success: false,
                    message: 'Validation failed',
                    errors
                });
            }

            // For other errors, log and pass to error handler
            logger.error('Validation middleware error', error);
            next(error);
        }
    };
};