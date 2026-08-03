import { cloudinary } from "./upload.js";

export function crearUrlImagen(req, file) {
  return file.path; // Cloudinary ya devuelve la URL https lista para usar
}

export async function eliminarImagenLocal(imagenUrl) {
  if (!imagenUrl) return;

  const publicId = extraerPublicId(imagenUrl);
  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error(`No se pudo eliminar la imagen de Cloudinary (${publicId}):`, error);
  }
}

function extraerPublicId(url) {
  try {
    const { pathname } = new URL(url);
    const partes = pathname.split("/upload/")[1];
    if (!partes) return null;
    const sinVersion = partes.replace(/^v\d+\//, "");
    return sinVersion.replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
}
