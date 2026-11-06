export const whereProductoVisible = { activo: true, web: true };
export const whereProductoPublicado = {
  ...whereProductoVisible,
  OR: [
    { coleccionId: null },
    { coleccion: { is: { fechaActivacion: { not: null } } } },
  ],
};

// Venta en el local: independiente de la publicación web, con la misma regla de lanzamiento de drops.
export const whereProductoLocal = {
  activo: true,
  local: true,
  OR: whereProductoPublicado.OR,
};

export function esProductoVisible(producto) {
  return producto?.activo === whereProductoVisible.activo && producto?.web === whereProductoVisible.web;
}

function dropLanzado(producto) {
  return producto.coleccionId == null || Boolean(producto.coleccion?.fechaActivacion);
}

export function esProductoPublicado(producto) {
  return esProductoVisible(producto) && dropLanzado(producto);
}

export function esProductoLocal(producto) {
  return producto?.activo === true && producto?.local === true && dropLanzado(producto);
}
