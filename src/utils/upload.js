import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/avif"];

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "pandocba",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "avif"],
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB por imagen
  fileFilter: (req, file, cb) => {
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(new Error("Formato de imagen no permitido (usá jpg, png, webp o avif)"));
    }
    cb(null, true);
  },
});

export { cloudinary };
