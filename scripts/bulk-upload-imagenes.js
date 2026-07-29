// Sube en batch las imágenes que ya tenés en tu PC.
//
// Organizá tus imágenes así:
//   imagenes/
//     12/          <- productoId
//       foto1.jpg
//       foto2.png
//     13/
//       zapatilla-front.webp
//
// Uso:
//   node scripts/bulk-upload-imagenes.js ./imagenes
//   node scripts/bulk-upload-imagenes.js ./imagenes http://localhost:3000

import fs from "fs";
import path from "path";

const carpetaBase = process.argv[2];
const apiUrl = process.argv[3] || "http://localhost:3000";

if (!carpetaBase) {
  console.error("Uso: node scripts/bulk-upload-imagenes.js <carpeta-con-subcarpetas-por-productoId> [apiUrl]");
  process.exit(1);
}

const extensionesValidas = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
const mimePorExtension = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

async function subirCarpeta(productoId, archivos) {
  const form = new FormData();
  form.append("productoId", productoId);

  for (const archivo of archivos) {
    const buffer = fs.readFileSync(archivo);
    const extension = path.extname(archivo).toLowerCase();
    const blob = new Blob([buffer], { type: mimePorExtension[extension] });
    form.append("imagenes", blob, path.basename(archivo));
  }

  const res = await fetch(`${apiUrl}/api/img-producto/upload`, {
    method: "POST",
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `Error ${res.status}`);
  }
  return data;
}

async function main() {
  const carpetasProducto = fs.readdirSync(carpetaBase, { withFileTypes: true }).filter((e) => e.isDirectory());

  if (!carpetasProducto.length) {
    console.log("No encontré subcarpetas (una por productoId) dentro de", carpetaBase);
    return;
  }

  for (const carpeta of carpetasProducto) {
    const productoId = carpeta.name;
    const carpetaCompleta = path.join(carpetaBase, carpeta.name);

    const archivos = fs
      .readdirSync(carpetaCompleta)
      .filter((nombre) => extensionesValidas.includes(path.extname(nombre).toLowerCase()))
      .map((nombre) => path.join(carpetaCompleta, nombre));

    if (!archivos.length) {
      console.log(`(productoId ${productoId}) sin imágenes válidas, salteado`);
      continue;
    }

    try {
      const creadas = await subirCarpeta(productoId, archivos);
      console.log(`✔ productoId ${productoId}: subidas ${creadas.length} imagen(es)`);
    } catch (error) {
      console.error(`✘ productoId ${productoId}: ${error.message}`);
    }
  }
}

main();
