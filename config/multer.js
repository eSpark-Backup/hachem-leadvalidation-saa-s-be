// config/multer.js
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '#utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create uploads directory outside of watched directories
const uploadDir = path.join(__dirname, '..', 'temp', 'uploads');

// Ensure upload folder exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    logger.info(`Created temp upload directory: ${uploadDir}`);
}

// Clean up old temp files on startup (files older than 1 hour)
const cleanupOldFiles = () => {
    try {
        const files = fs.readdirSync(uploadDir);
        const oneHourAgo = Date.now() - (60 * 60 * 1000);

        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);

            if (stats.mtime.getTime() < oneHourAgo) {
                fs.unlinkSync(filePath);
                logger.debug(`Cleaned up old temp file: ${file}`);
            }
        });
    } catch (error) {
        logger.warn('Failed to cleanup old temp files:', error.message);
    }
};

// Run cleanup on startup
cleanupOldFiles();

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Create unique filename to avoid conflicts
        const timestamp = Date.now();
        const randomSuffix = Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const baseName = path.basename(file.originalname, ext);
        const safeName = baseName.replace(/[^a-zA-Z0-9]/g, '_');

        const filename = `${timestamp}_${randomSuffix}_${safeName}${ext}`;
        cb(null, filename);
    },
});

// File filter function
function fileFilter(req, file, cb) {
    // Check file extension
    const allowedExtensions = ['.json'];
    const fileExt = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(fileExt)) {
        const error = new Error('Only JSON files are allowed');
        error.code = 'INVALID_FILE_TYPE';
        return cb(error, false);
    }

    // Check MIME type
    const allowedMimeTypes = ['application/json', 'text/json', 'text/plain'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
        logger.warn(`File rejected due to MIME type: ${file.mimetype} for file: ${file.originalname}`);
        // Don't reject based on MIME type alone, as it can be inconsistent
    }

    cb(null, true);
}

// Multer configuration
const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50 MB limit
        files: 1 // Only allow 1 file per upload
    },
});

// Error handler for multer errors
const handleMulterError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        logger.error('Multer error:', error);

        switch (error.code) {
            case 'LIMIT_FILE_SIZE':
                return res.status(413).json({
                    success: false,
                    message: 'File size exceeds maximum limit (50MB)',
                    error: 'FILE_TOO_LARGE'
                });
            case 'LIMIT_FILE_COUNT':
                return res.status(400).json({
                    success: false,
                    message: 'Too many files. Only 1 file allowed per upload',
                    error: 'TOO_MANY_FILES'
                });
            case 'LIMIT_UNEXPECTED_FILE':
                return res.status(400).json({
                    success: false,
                    message: 'Unexpected field name. Use "file" as the field name',
                    error: 'UNEXPECTED_FIELD'
                });
            default:
                return res.status(400).json({
                    success: false,
                    message: 'File upload error',
                    error: error.code
                });
        }
    }

    if (error.code === 'INVALID_FILE_TYPE') {
        return res.status(415).json({
            success: false,
            message: 'Invalid file type. Only JSON files are supported',
            error: 'INVALID_FILE_TYPE'
        });
    }

    next(error);
};

// Cleanup function to remove temporary files
export const cleanupTempFile = (filePath) => {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logger.debug(`Cleaned up temp file: ${filePath}`);
        }
    } catch (error) {
        logger.warn(`Failed to cleanup temp file ${filePath}:`, error.message);
    }
};

// Schedule periodic cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

export { handleMulterError };
export default upload;