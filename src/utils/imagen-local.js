import fs from "fs/promises";
import path from "path";
import { uploadsDir } from "./upload.js";

export function crearUrlImagen(req, filename) {
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/uploads/${filename}`;
}

export async function eliminarImagenLocal(imagenUrl) {
  if (!imagenUrl) return;

  let pathname;
  try {
    pathname = new URL(imagenUrl).pathname;
  } catch {
    pathname = imagenUrl;
  }

  const prefijoUploads = "/uploads/";
  if (!pathname.startsWith(prefijoUploads)) return;

  const filename = decodeURIComponent(pathname.slice(prefijoUploads.length));
  if (!filename || filename !== path.basename(filename)) return;

  try {
    await fs.unlink(path.join(uploadsDir, filename));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`No se pudo eliminar la imagen local ${filename}:`, error);
    }
  }
}
