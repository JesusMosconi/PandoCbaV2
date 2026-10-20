export const whereProductoVisible = { activo: true, web: true };

export function esProductoVisible(producto) {
  return producto?.activo === whereProductoVisible.activo && producto?.web === whereProductoVisible.web;
}
