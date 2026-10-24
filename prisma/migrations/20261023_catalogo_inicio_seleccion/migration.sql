-- Conservar la fila al quitar un producto de la selección de Inicio.
ALTER TABLE "CatalogoInicio" ADD COLUMN "activo" BOOLEAN NOT NULL DEFAULT true;

-- Ejecutar antes de aplicar: comprobar productoId repetidos y una selección inicial
-- de hasta cinco filas. Si hay conflictos, detener y conciliar sin borrar datos.
CREATE UNIQUE INDEX "CatalogoInicio_productoId_key" ON "CatalogoInicio"("productoId");
