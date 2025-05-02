// controllers/authController.js
import { authService, googleAuthService } from '#services';
import { logger } from '#utils';

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
export const register = async (req, res) => {
    try {
        const { fullname, email, password, company, role } = req.body;

        // Validate input (additional validation happens in middleware)
        if (!fullname || !email || !password || !role) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Validate role
        if (!['client', 'supplier'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role. Must be either "client" or "supplier"'
            });
        }

        const result = await authService.register({
            fullname,
            email,
            password,
            company,
            role
        });

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(201).json(result);
    } catch (error) {
        logger.error('Registration controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during registration'
        });
    }
};

/**
 * @desc    Verify email with verification code
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
export const verifyEmail = async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({
                success: false,
                message: 'Email and verification code are required'
            });
        }

        const result = await authService.verifyEmail(email, code);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Email verification controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during email verification'
        });
    }
};

/**
 * @desc    Resend verification email
 * @route   POST /api/auth/resend-verification
 * @access  Public
 */
export const resendVerification = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const result = await authService.resendVerification(email);
        return res.status(200).json(result);
    } catch (error) {
        logger.error('Resend verification controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while resending verification'
        });
    }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.connection.remoteAddress;

        const result = await authService.login(email, password, userAgent, ipAddress);

        if (!result.success) {
            return res.status(401).json(result);
        }

        // Set refresh token as HTTP-only cookie
        res.cookie('refreshToken', result.tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV !== 'development',
            sameSite: 'strict',
            maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
            path: '/api/auth/refresh'
        });

        // Don't include refresh token in response body in production
        if (process.env.NODE_ENV === 'production') {
            delete result.tokens.refreshToken;
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Login controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during login'
        });
    }
};

/**
 * @desc    Refresh access token
 * @route   POST /api/auth/refresh
 * @access  Public
 */
export const refreshToken = async (req, res) => {
    try {
        // Get refresh token from cookie or request body
        const token = req.cookies?.refreshToken || req.body.refreshToken;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.connection.remoteAddress;

        const result = await authService.refreshTokens(token, userAgent, ipAddress);

        if (!result.success) {
            // Clear the invalid cookie
            res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
            return res.status(401).json(result);
        }

        // Set new refresh token as HTTP-only cookie
        res.cookie('refreshToken', result.tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV !== 'development',
            sameSite: 'strict',
            maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
            path: '/api/auth/refresh'
        });

        // Don't include refresh token in response body in production
        if (process.env.NODE_ENV === 'production') {
            delete result.tokens.refreshToken;
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Token refresh controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during token refresh'
        });
    }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Public
 */
export const logout = async (req, res) => {
    try {
        // Get refresh token from cookie or request body
        const token = req.cookies?.refreshToken || req.body.refreshToken;

        // Clear the cookie regardless
        res.clearCookie('refreshToken', { path: '/api/auth/refresh' });

        if (!token) {
            return res.status(200).json({
                success: true,
                message: 'Logged out successfully'
            });
        }

        const result = await authService.logout(token);
        return res.status(200).json(result);
    } catch (error) {
        logger.error('Logout controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during logout'
        });
    }
};

/**
 * @desc    Request password reset
 * @route   POST /api/auth/reset-request
 * @access  Public
 */
export const requestPasswordReset = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const result = await authService.requestPasswordReset(email);
        return res.status(200).json(result);
    } catch (error) {
        logger.error('Password reset request controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during password reset request'
        });
    }
};

/**
 * @desc    Reset password with token
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
export const resetPassword = async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({
                success: false,
                message: 'Token and new password are required'
            });
        }

        const result = await authService.resetPassword(token, password);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Password reset controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during password reset'
        });
    }
};

/**
 * @desc    Handle Google Sign-in
 * @route   POST /api/auth/google
 * @access  Public
 */
export const googleSignIn = async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'Google ID token is required'
            });
        }

        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.connection.remoteAddress;

        const result = await googleAuthService.handleGoogleSignIn(idToken, userAgent, ipAddress);

        if (!result.success) {
            return res.status(401).json(result);
        }

        // Set refresh token as HTTP-only cookie
        res.cookie('refreshToken', result.tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV !== 'development',
            sameSite: 'strict',
            maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
            path: '/api/auth/refresh'
        });

        // Don't include refresh token in response body in production
        if (process.env.NODE_ENV === 'production') {
            delete result.tokens.refreshToken;
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Google sign-in controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during Google sign-in'
        });
    }
};

/**
 * @desc    Get current user info
 * @route   GET /api/auth/me
 * @access  Private
 */
export const getCurrentUser = async (req, res) => {
    try {
        // The authenticate middleware already added user to req
        return res.status(200).json({
            success: true,
            user: req.user
        });
    } catch (error) {
        logger.error('Get current user controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

/**
 * @desc    Check if email is available (not already registered)
 * @route   POST /api/auth/check-email
 * @access  Public
 */
export const checkEmail = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const user = await authService.findUserByEmail(email);

        return res.status(200).json({
            success: true,
            available: !user,
            message: !user
                ? 'Email is available'
                : 'Email is already registered'
        });
    } catch (error) {
        logger.error('Check email controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during email check'
        });
    }
};

/**
 * @desc    Update user profile
 * @route   PUT /api/auth/profile
 * @access  Private
 */
export const updateProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { fullname, company } = req.body;

        // Only allow updating certain fields
        const updateData = {};
        if (fullname) updateData.fullname = fullname;
        if (company !== undefined) updateData.company = company;

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields to update'
            });
        }

        const result = await authService.updateUserProfile(userId, updateData);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Update profile controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during profile update'
        });
    }
};

/**
 * @desc    Change user password
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
export const changePassword = async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        const result = await authService.changePassword(userId, currentPassword, newPassword);

        if (!result.success) {
            return res.status(400).json(result);
        }

        // Force logout from all devices by clearing cookie and invalidating all refresh tokens
        res.clearCookie('refreshToken', { path: '/api/auth/refresh' });

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Change password controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during password change'
        });
    }
};

/**
 * @desc    Get active sessions for current user
 * @route   GET /api/auth/sessions
 * @access  Private
 */
export const getUserSessions = async (req, res) => {
    try {
        const userId = req.user.id;

        const result = await authService.getUserSessions(userId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Get user sessions controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while retrieving sessions'
        });
    }
};

/**
 * @desc    Terminate a specific session
 * @route   DELETE /api/auth/sessions/:sessionId
 * @access  Private
 */
export const terminateSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const { sessionId } = req.params;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: 'Session ID is required'
            });
        }

        const result = await authService.terminateSession(userId, sessionId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Terminate session controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while terminating session'
        });
    }
};

/**
 * @desc    Terminate all sessions except current
 * @route   DELETE /api/auth/sessions
 * @access  Private
 */
export const terminateAllSessions = async (req, res) => {
    try {
        const userId = req.user.id;
        // Get current token from cookie or request body
        const currentToken = req.cookies?.refreshToken || req.body.refreshToken;

        if (!currentToken) {
            return res.status(400).json({
                success: false,
                message: 'Current session token is required'
            });
        }

        const result = await authService.terminateAllSessionsExceptCurrent(userId, currentToken);

        if (!result.success) {
            return res.status(400).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        logger.error('Terminate all sessions controller error', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while terminating sessions'
        });
    }
};

// Export all controllers
export default {
    register,
    verifyEmail,
    resendVerification,
    login,
    refreshToken,
    logout,
    requestPasswordReset,
    resetPassword,
    googleSignIn,
    getCurrentUser,
    checkEmail,
    updateProfile,
    changePassword,
    getUserSessions,
    terminateSession,
    terminateAllSessions
};