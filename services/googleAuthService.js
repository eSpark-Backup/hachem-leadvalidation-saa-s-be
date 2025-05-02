// services/auth/googleAuthService.js
import { User } from '#models';
import {authService} from './authService.js';
import { logger } from '#utils';

class GoogleAuthService {
    constructor() {
    }
    // Handle Google Sign-in
    async handleGoogleSignIn(idToken, userAgent, ipAddress) {
        try {
            // Find or create user
            const user = await User.findOrCreateByGoogleId({
                id: googleProfile.sub,
                email: googleProfile.email,
                name: googleProfile.name
            });

            if (!user || !user.is_active) {
                return { success: false, message: 'Account is inactive or unavailable' };
            }

            // Generate tokens
            const accessToken = authService.generateAccessToken(user);
            const refreshToken = await authService.generateRefreshToken(user, userAgent, ipAddress);

            return {
                success: true,
                message: 'Google authentication successful',
                user: {
                    id: user.id,
                    fullname: user.fullname,
                    email: user.email,
                    role: user.role
                },
                tokens: {
                    accessToken,
                    refreshToken
                }
            };
        } catch (error) {
            logger.error('Google authentication error', error);
            return { success: false, message: 'Google authentication failed' };
        }
    }
}

export const googleAuthService = new GoogleAuthService();