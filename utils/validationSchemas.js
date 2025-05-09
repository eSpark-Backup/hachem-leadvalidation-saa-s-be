// utils/validationSchemas.js
import * as yup from 'yup';

// Password validation schema
export const passwordSchema = yup
    .string()
    .min(10, 'Password must be at least 10 characters long')
    .matches(/[a-z]/, 'Password must contain at least one lowercase letter')
    .matches(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .matches(/[0-9]/, 'Password must contain at least one number')
    .matches(/[^a-zA-Z0-9]/, 'Password must contain at least one special character')
    .required('Password is required');

// Registration validation schema
export const registrationSchema = yup.object({
    fullname: yup
        .string()
        .min(3, 'Full name must be at least 3 characters long')
        .max(255, 'Full name must be at most 255 characters long')
        .required('Full name is required'),
    email: yup
        .string()
        .email('Invalid email format')
        .required('Email is required'),
    password: passwordSchema,
    company: yup
        .string()
        .max(255, 'Company name must be at most 255 characters long')
        .nullable(),
    role: yup
        .string()
        .oneOf(['client', 'supplier'], 'Role must be either client or supplier')
        .required('Role is required')
});

// Login validation schema
export const loginSchema = yup.object({
    email: yup
        .string()
        .email('Invalid email format')
        .required('Email is required'),
    password: yup
        .string()
        .required('Password is required')
});

// Email verification schema
export const verificationSchema = yup.object({
    email: yup
        .string()
        .email('Invalid email format')
        .required('Email is required'),
    code: yup
        .string()
        .matches(/^\d{6}$/, 'Verification code must be 6 digits')
        .required('Verification code is required')
});

// Password reset request schema
export const resetRequestSchema = yup.object({
    email: yup
        .string()
        .email('Invalid email format')
        .required('Email is required')
});

// Password reset schema
export const resetPasswordSchema = yup.object({
    token: yup
        .string()
        .required('Token is required'),
    password: passwordSchema
});

// Google sign-in schema
export const googleSignInSchema = yup.object({
    idToken: yup
        .string()
        .required('Google ID token is required')
});

export default {
    passwordSchema,
    registrationSchema,
    loginSchema,
    verificationSchema,
    resetRequestSchema,
    resetPasswordSchema,
    googleSignInSchema
};