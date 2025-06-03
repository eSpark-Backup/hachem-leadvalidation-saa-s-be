// middleware/index.js - Updated to include client API key authentication
export * from './auth.js';
export { setupSwagger } from './swagger.js';
export { validate } from './validation.js';

// Supplier API Key Authentication (existing)
export {
    authenticateApiKey,
    requireSupplierRole,
    rateLimitApiKey
} from './apiKeyAuth.js';

// Client API Key Authentication (new)
export {
    authenticateClientApiKey,
    requireClientRole,
    rateLimitClientApiKey,
    authenticateClientFlexible
} from './clientApiKeyAuth.js';
