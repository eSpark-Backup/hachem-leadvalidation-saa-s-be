// services/auth/authService.js
import jwt from 'jsonwebtoken';
import { User, RefreshToken } from '#models';
import { logger } from '#utils';
import EmailService from '#services/emailService';

class AuthService {
    constructor() {
        this.emailService = new EmailService();
    }

    // Generate access token (short-lived)
    generateAccessToken(user) {
        const payload = {
            sub: user.id,
            role: user.role,
            email: user.email,
            type: 'access'
        };

        const options = {
            expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m'
        };

        return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, options);
    }

    // Generate refresh token (long-lived)
    async generateRefreshToken(user, userAgent, ipAddress) {
        const refreshToken = await RefreshToken.create(user.id, userAgent, ipAddress);
        return refreshToken.token;
    }

    // Register a new user
    async register(userData) {
        try {
            // Check if email already exists
            const existingUser = await User.findByEmail(userData.email);
            if (existingUser) {
                return { success: false, message: 'Email already in use' };
            }

            // Create the user
            const user = await User.create(userData);


            // Send verification email
            await this.emailService.sendVerificationEmail(
                user.email,
                userData.verification_code,
                user.fullname.split(' ')[0]
            );

            return {
                success: true,
                message: 'User registered successfully. Please verify your email.',
                user: {
                    id: user.id,
                    fullname: user.fullname,
                    email: user.email,
                    role: user.role
                }
            };
        } catch (error) {
            logger.error('Registration error', error);
            return { success: false, message: 'Registration failed' };
        }
    }

    // Verify email
    async verifyEmail(email, code) {
        try {
            const user = await User.verifyEmail(email, code);

            if (!user) {
                return {
                    success: false,
                    message: 'Invalid or expired verification code'
                };
            }

            return {
                success: true,
                message: 'Email successfully verified',
                user: {
                    id: user.id,
                    fullname: user.fullname,
                    email: user.email,
                    role: user.role,
                    isVerified: user.is_verified
                }
            };
        } catch (error) {
            logger.error('Email verification error', error);
            return { success: false, message: 'Email verification failed' };
        }
    }

    // Resend verification email
    async resendVerification(email) {
        try {
            const result = await User.generateNewVerificationCode(email);

            if (!result) {
                return {
                    success: false,
                    message: 'User not found or already verified'
                };
            }

            // Send new verification email
            await this.emailService.sendVerificationEmail(
                result.user.email,
                result.verificationCode,
                result.user.fullname.split(' ')[0]
            );

            return {
                success: true,
                message: 'Verification email resent successfully'
            };
        } catch (error) {
            logger.error('Resend verification error', error);
            return { success: false, message: 'Failed to resend verification email' };
        }
    }

    // Login user
    async login(email, password, userAgent, ipAddress) {
        try {
            // Validate credentials
            const validation = await User.validatePassword(email, password);

            if (!validation.valid) {
                switch (validation.reason) {
                    case 'user_not_found':
                        return { success: false, message: 'Invalid email or password' };
                    case 'invalid_password':
                        return { success: false, message: 'Invalid email or password' };
                    case 'email_not_verified':
                        return {
                            success: false,
                            message: 'Email not verified',
                            needsVerification: true,
                            email
                        };
                    case 'account_inactive':
                        return { success: false, message: 'Account is inactive' };
                    default:
                        return { success: false, message: 'Authentication failed' };
                }
            }

            // Get user details
            const user = await User.findById(validation.userId);

            // Generate tokens
            const accessToken = this.generateAccessToken(user);
            const refreshToken = await this.generateRefreshToken(user, userAgent, ipAddress);

            return {
                success: true,
                message: 'Login successful',
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
            logger.error('Login error', error);
            return { success: false, message: 'Login failed' };
        }
    }

    // Refresh tokens
    async refreshTokens(token, userAgent, ipAddress) {
        try {
            // Find the refresh token
            const refreshTokenRecord = await RefreshToken.findByToken(token);

            if (!refreshTokenRecord) {
                return { success: false, message: 'Invalid refresh token' };
            }

            // Create a user object from token data
            const user = {
                id: refreshTokenRecord.user_id,
                fullname: refreshTokenRecord.fullname,
                email: refreshTokenRecord.email,
                role: refreshTokenRecord.role
            };

            // Check if user is still active
            if (!refreshTokenRecord.is_active) {
                await RefreshToken.delete(token);
                return { success: false, message: 'User account is inactive' };
            }

            // Delete the old refresh token (token rotation)
            await RefreshToken.delete(token);

            // Generate new tokens
            const accessToken = this.generateAccessToken(user);
            const newRefreshToken = await this.generateRefreshToken(user, userAgent, ipAddress);

            return {
                success: true,
                message: 'Token refreshed successfully',
                tokens: {
                    accessToken,
                    refreshToken: newRefreshToken
                }
            };
        } catch (error) {
            logger.error('Token refresh error', error);
            return { success: false, message: 'Failed to refresh token' };
        }
    }

    // Logout user
    async logout(refreshToken) {
        try {
            if (!refreshToken) {
                return { success: false, message: 'No token provided' };
            }

            const deleted = await RefreshToken.delete(refreshToken);

            return {
                success: deleted,
                message: deleted ? 'Logged out successfully' : 'Invalid token'
            };
        } catch (error) {
            logger.error('Logout error', error);
            return { success: false, message: 'Logout failed' };
        }
    }

    // Request password reset
    async requestPasswordReset(email) {
        try {
            const result = await User.generatePasswordResetToken(email);

            if (!result) {
                // Don't reveal if email exists for security reasons
                return { success: true, message: 'If your email exists, you will receive password reset instructions' };
            }

            //TODO: Ask for frontend password email link
            const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${result.resetToken}`;

            // Send password reset email
            await this.emailService.sendPasswordResetEmail(
                result.user.email,
                resetLink,
                result.user.fullname.split(' ')[0]
            );

            return {
                success: true,
                message: 'Password reset instructions sent to your email'
            };
        } catch (error) {
            logger.error('Password reset request error', error);
            return { success: false, message: 'Failed to process password reset request' };
        }
    }

    // Reset password with token
    async resetPassword(token, newPassword) {
        try {
            const result = await User.resetPassword(token, newPassword);

            if (!result) {
                return { success: false, message: 'Invalid or expired reset token' };
            }

            // Invalidate all refresh tokens for this user (force re-login after password change)
            await RefreshToken.deleteAllForUser(result.id);

            return {
                success: true,
                message: 'Password reset successful. Please log in with your new password.'
            };
        } catch (error) {
            logger.error('Password reset error', error);
            return { success: false, message: 'Failed to reset password' };
        }
    }

    // Verify a JWT token
    verifyToken(token, type = 'access') {
        try {
            const secret = type === 'access'
                ? process.env.JWT_ACCESS_SECRET
                : process.env.JWT_REFRESH_SECRET;

            const decoded = jwt.verify(token, secret);

            // Ensure token is of correct type
            if (decoded.type !== type) {
                throw new Error('Invalid token type');
            }

            return {
                valid: true,
                decoded
            };
        } catch (error) {
            logger.debug('Token verification failed', { error: error.message });
            return {
                valid: false,
                error: error.message
            };
        }
    }
}

export const authService = new AuthService()