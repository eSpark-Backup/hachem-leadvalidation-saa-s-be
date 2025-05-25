import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Ensure upload folder exists
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const safeName = file.originalname.replace(/\s+/g, '-');
        cb(null, `${timestamp}-${safeName}`);
    },
});

function fileFilter(req, file, cb) {
    if (file.mimetype === 'application/json') {
        cb(null, true);
    } else {
        cb(new Error('Only JSON files are allowed'), false);
    }
}

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB limit
});

export default upload;
