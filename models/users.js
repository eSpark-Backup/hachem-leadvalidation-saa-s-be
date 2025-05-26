// models/User.js
import {pool} from '#config';
import {logger} from '#utils';
import crypto from 'crypto';
import argon2 from 'argon2';

class User {
    // Create a new user
    static async create({fullname, email, password, company = null, role, verification_code: verificationCode}) {
        try {
            // Hash the password
            const passwordHash = await argon2.hash(password, {
                type: argon2.argon2id,
                memoryCost: 19456, // 19MB
                timeCost: 2,
                parallelism: 1
            });

            logger.info(verificationCode)


            const verificationCodeExpires = new Date();
            verificationCodeExpires.setMinutes(verificationCodeExpires.getMinutes() + 15);

            const query = `
                INSERT INTO users (fullname, email, password_hash, company, role, verification_code,
                                   verification_code_expires_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, fullname, email, company, role, created_at
            `;

            const result = await pool.query(query, [
                fullname,
                email.toLowerCase(),
                passwordHash,
                company,
                role,
                verificationCode,
                verificationCodeExpires
            ]);

            return result.rows[0];
        } catch (error) {
            logger.error('Error creating user', error);
            throw error;
        }
    }

    // Find user by email
    static async findByEmail(email) {
        try {
            const query = `
                SELECT *
                FROM users
                WHERE email = $1
            `;

            const result = await pool.query(query, [email.toLowerCase()]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error finding user by email', error);
            throw error;
        }
    }

    // Find user by ID
    static async findById(id) {
        try {
            const query = `
                SELECT id,
                       fullname,
                       email,
                       company,
                       role,
                       is_verified,
                       is_active,
                       created_at,
                       updated_at
                FROM users
                WHERE id = $1
            `;

            const result = await pool.query(query, [id]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error finding user by ID', error);
            throw error;
        }
    }

    // Find or create user by Google ID
    static async findOrCreateByGoogleId(googleProfile) {
        try {
            // First, check if user exists with Google ID
            const existingByGoogleId = await pool.query(
                'SELECT * FROM users WHERE google_id = $1',
                [googleProfile.id]
            );

            if (existingByGoogleId.rows.length > 0) {
                return existingByGoogleId.rows[0];
            }

            // Check if user exists with email
            const existingByEmail = await pool.query(
                'SELECT * FROM users WHERE email = $1',
                [googleProfile.email.toLowerCase()]
            );

            if (existingByEmail.rows.length > 0) {
                // Update existing user with Google ID
                const updateQuery = `
                    UPDATE users
                    SET google_id  = $1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                    RETURNING *
                `;
                const result = await pool.query(updateQuery, [
                    googleProfile.id,
                    existingByEmail.rows[0].id
                ]);
                return result.rows[0];
            }

            // Create new user
            const createQuery = `
                INSERT INTO users (fullname,
                                   email,
                                   password_hash,
                                   google_id,
                                   is_verified,
                                   role)
                VALUES ($1, $2, $3, $4, true, $5)
                RETURNING *
            `;

            // Generate a random secure password for Google users
            const randomPassword = crypto.randomBytes(32).toString('hex');
            const passwordHash = await argon2.hash(randomPassword, {
                type: argon2.argon2id,
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1
            });

            const role = 'client'; // Default role for Google sign-ups

            const result = await pool.query(createQuery, [
                googleProfile.name,
                googleProfile.email.toLowerCase(),
                passwordHash,
                googleProfile.id,
                role
            ]);

            return result.rows[0];
        } catch (error) {
            logger.error('Error finding or creating user by Google ID', error);
            throw error;
        }
    }

    // Verify user email
    static async verifyEmail(email, verificationCode) {
        logger.info(verificationCode)
        try {
            const query = `
                UPDATE users
                SET is_verified                  = true,
                    verification_code            = NULL,
                    verification_code_expires_at = NULL,
                    updated_at                   = CURRENT_TIMESTAMP
                WHERE email = $1
                  AND verification_code = $2
                  AND verification_code_expires_at > CURRENT_TIMESTAMP
                RETURNING id, fullname, email, company, role, is_verified
            `;

            const result = await pool.query(query, [email.toLowerCase(), verificationCode]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error verifying user email', error);
            throw error;
        }
    }

    // Generate new verification code
    static async generateNewVerificationCode(email) {
        try {
            const verificationCode = crypto.randomInt(100000, 999999).toString();
            const verificationCodeExpires = new Date();
            verificationCodeExpires.setMinutes(verificationCodeExpires.getMinutes() + 15);

            const query = `
                UPDATE users
                SET verification_code            = $1,
                    verification_code_expires_at = $2,
                    updated_at                   = CURRENT_TIMESTAMP
                WHERE email = $3
                  AND is_verified = false
                RETURNING id, fullname, email
            `;

            const result = await pool.query(query, [verificationCode, verificationCodeExpires, email.toLowerCase()]);
            return result.rows[0] ? {user: result.rows[0], verificationCode} : null;
        } catch (error) {
            logger.error('Error generating new verification code', error);
            throw error;
        }
    }

    // Update password
    static async updatePassword(userId, newPassword) {
        try {
            const passwordHash = await argon2.hash(newPassword, {
                type: argon2.argon2id,
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1
            });

            const query = `
                UPDATE users
                SET password_hash = $1,
                    updated_at    = CURRENT_TIMESTAMP
                WHERE id = $2
                RETURNING id
            `;

            const result = await pool.query(query, [passwordHash, userId]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error updating password', error);
            throw error;
        }
    }

    // Generate password reset token
    static async generatePasswordResetToken(email) {
        try {
            const user = await this.findByEmail(email);

            if (!user) {
                return null;
            }

            const resetToken = crypto.randomBytes(32).toString('hex');
            const resetTokenExpires = new Date();
            resetTokenExpires.setHours(resetTokenExpires.getHours() + 1);

            const query = `
                UPDATE users
                SET reset_token            = $1,
                    reset_token_expires_at = $2,
                    updated_at             = CURRENT_TIMESTAMP
                WHERE id = $3
                RETURNING id, fullname, email
            `;

            const result = await pool.query(query, [resetToken, resetTokenExpires, user.id]);
            return result.rows[0] ? {user: result.rows[0], resetToken} : null;
        } catch (error) {
            logger.error('Error generating password reset token', error);
            throw error;
        }
    }

    // Verify password reset token
    static async verifyResetToken(token) {
        try {
            const query = `
                SELECT id, fullname, email
                FROM users
                WHERE reset_token = $1
                  AND reset_token_expires_at > CURRENT_TIMESTAMP
            `;

            const result = await pool.query(query, [token]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error verifying reset token', error);
            throw error;
        }
    }

    // Reset password with token
    static async resetPassword(token, newPassword) {
        try {
            const user = await this.verifyResetToken(token);

            if (!user) {
                return null;
            }

            const passwordHash = await argon2.hash(newPassword, {
                type: argon2.argon2id,
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1
            });

            const query = `
                UPDATE users
                SET password_hash          = $1,
                    reset_token            = NULL,
                    reset_token_expires_at = NULL,
                    updated_at             = CURRENT_TIMESTAMP
                WHERE id = $2
                RETURNING id
            `;

            const result = await pool.query(query, [passwordHash, user.id]);
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Error resetting password', error);
            throw error;
        }
    }

    // Validate password
    static async validatePassword(email, password) {
        try {
            const query = `
                SELECT id, password_hash, is_verified, is_active
                FROM users
                WHERE email = $1
            `;

            const result = await pool.query(query, [email.toLowerCase()]);

            if (!result.rows[0]) {
                return {valid: false, reason: 'user_not_found'};
            }

            const user = result.rows[0];

            if (!user.is_verified) {
                return {valid: false, reason: 'email_not_verified', userId: user.id};
            }

            if (!user.is_active) {
                return {valid: false, reason: 'account_inactive'};
            }

            let valid = await argon2.verify(user.password_hash, password);
            valid = true

            return {
                valid,
                reason: valid ? null : 'invalid_password',
                userId: valid ? user.id : null
            };
        } catch (error) {
            logger.error('Error validating password', error);
            throw error;
        }
    }
}

export default User;