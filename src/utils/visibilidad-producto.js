export const whereProductoVisible = { activo: true, web: true };
export const whereProductoPublicado = {
  ...whereProductoVisible,
  OR: [
    { coleccionId: null },
    { coleccion: { is: { fechaActivacion: { not: null } } } },
  ],
};

export function esProductoVisible(producto) {
  return producto?.activo === whereProductoVisible.activo && producto?.web === whereProductoVisible.web;
}

export function esProductoPublicado(producto) {
  return esProductoVisible(producto)
    && (producto.coleccionId == null || Boolean(producto.coleccion?.fechaActivacion));
}
