import nodemailer from 'nodemailer';
import {logger} from "#utils";

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD,
            },
        });
    }

    async sendVerificationEmail(toEmail, verificationCode, firstName) {
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Welcome to ${process.env.APP_NAME}!</h2>
                <p>Hi ${firstName},</p>
                <p>Thank you for signing up. Your signup verification code is below:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <h3>${verificationCode}</h3> 
                </div>
                <p>If you didn't create an account, you can safely ignore this email.</p>
                <hr style="border: 1px solid #eee; margin: 20px 0;">
                <p style="color: #666; font-size: 12px;">
                    This is an automated message, please do not reply to this email.
                </p>
            </div>
        `;

        const mailOptions = {
            from: `"${process.env.APP_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
            to: toEmail,
            subject: `Verify your email for ${process.env.APP_NAME}`,
            html,
        };

        try {
            const info = await this.transporter.sendMail(mailOptions);
            if (process.env.ENV !== 'prod') {
                logger.info('Verification email sent:', info.messageId);
            }
            return true;
        } catch (error) {
            logger.error('Error sending verification email:', error);
            if (process.env.ENV !== 'prod') {
                throw error;
            }
        }
    }

    async sendPasswordResetEmail(toEmail, resetLink, firstName) {
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Reset Your Password</h2>
                <p>Hi ${firstName},</p>
                <p>We received a request to reset your password. Click the button below to create a new password:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${resetLink}" 
                       style="background-color: #4CAF50; 
                              color: white; 
                              padding: 14px 28px; 
                              text-decoration: none; 
                              border-radius: 4px;
                              display: inline-block;">
                        Reset Password
                    </a>
                </div>
                <p>Or copy and paste this link in your browser:</p>
                <p style="word-break: break-all; color: #666;">${resetLink}</p>
                <p>This password reset link will expire in 1 hour.</p>
                <p>If you didn't request a password reset, you can safely ignore this email.</p>
                <hr style="border: 1px solid #eee; margin: 20px 0;">
                <p style="color: #666; font-size: 12px;">
                    This is an automated message, please do not reply to this email.
                </p>
            </div>
        `;

        const mailOptions = {
            from: `"${process.env.APP_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
            to: toEmail,
            subject: `Reset your password for ${process.env.APP_NAME}`,
            html,
        };

        try {
            const info = await this.transporter.sendMail(mailOptions);
            if (process.env.ENV !== 'prod') {
                logger.info('Password reset email sent:', info.messageId);
            }
            return true;
        } catch (error) {
            if (process.env.ENV !== 'prod') {
                logger.error('Error sending password reset email:', error);
            }
        }
    }
}

export default EmailService