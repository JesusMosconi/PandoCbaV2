-- AlterTable
ALTER TABLE "Producto" ADD COLUMN     "creadoDesdeCompras" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TalleProducto" ADD COLUMN     "inicioInventarioCero" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Proveedor" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "contacto" TEXT,
    "observaciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventoProveedor" (
    "id" SERIAL NOT NULL,
    "proveedorId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "valoresAnteriores" JSONB,
    "valoresNuevos" JSONB,
    "actorUsuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventoProveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingreso" (
    "id" SERIAL NOT NULL,
    "proveedorId" INTEGER NOT NULL,
    "fechaCompra" DATE NOT NULL,
    "fechaRecepcion" DATE NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "observaciones" TEXT,
    "comprobanteReferencia" TEXT,
    "claveOperacion" TEXT,
    "huellaSolicitud" TEXT,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmadoEn" TIMESTAMPTZ(3),
    "confirmadoPorId" INTEGER,

    CONSTRAINT "Ingreso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GastoAdicionalCompra" (
    "id" SERIAL NOT NULL,
    "ingresoId" INTEGER NOT NULL,
    "concepto" TEXT NOT NULL,
    "importe" DECIMAL(14,2) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GastoAdicionalCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineaIngreso" (
    "id" SERIAL NOT NULL,
    "ingresoId" INTEGER NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(14,2) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LineaIngreso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartidaInventario" (
    "id" SERIAL NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "ingresoId" INTEGER,
    "origen" TEXT NOT NULL,
    "cantidadOriginal" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(14,2),
    "fechaRecepcion" DATE,
    "confirmadaEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartidaInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovimientoInventario" (
    "id" SERIAL NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "partidaId" INTEGER,
    "ingresoId" INTEGER,
    "tipo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "motivo" TEXT,
    "actorUsuarioId" INTEGER,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovimientoInventario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventoProveedor_proveedorId_fecha_idx" ON "EventoProveedor"("proveedorId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "Ingreso_claveOperacion_key" ON "Ingreso"("claveOperacion");

-- CreateIndex
CREATE INDEX "Ingreso_proveedorId_fechaRecepcion_idx" ON "Ingreso"("proveedorId", "fechaRecepcion");

-- CreateIndex
CREATE INDEX "Ingreso_estado_fechaRecepcion_idx" ON "Ingreso"("estado", "fechaRecepcion");

-- CreateIndex
CREATE INDEX "GastoAdicionalCompra_ingresoId_idx" ON "GastoAdicionalCompra"("ingresoId");

-- CreateIndex
CREATE INDEX "LineaIngreso_varianteId_idx" ON "LineaIngreso"("varianteId");

-- CreateIndex
CREATE UNIQUE INDEX "LineaIngreso_ingresoId_varianteId_key" ON "LineaIngreso"("ingresoId", "varianteId");

-- CreateIndex
CREATE INDEX "PartidaInventario_varianteId_origen_fechaRecepcion_confirma_idx" ON "PartidaInventario"("varianteId", "origen", "fechaRecepcion", "confirmadaEn", "id");

-- CreateIndex
CREATE INDEX "PartidaInventario_ingresoId_idx" ON "PartidaInventario"("ingresoId");

-- CreateIndex
CREATE INDEX "MovimientoInventario_varianteId_fecha_idx" ON "MovimientoInventario"("varianteId", "fecha");

-- CreateIndex
CREATE INDEX "MovimientoInventario_partidaId_fecha_idx" ON "MovimientoInventario"("partidaId", "fecha");

-- CreateIndex
CREATE INDEX "MovimientoInventario_ingresoId_idx" ON "MovimientoInventario"("ingresoId");

-- AddForeignKey
ALTER TABLE "EventoProveedor" ADD CONSTRAINT "EventoProveedor_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingreso" ADD CONSTRAINT "Ingreso_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "Proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GastoAdicionalCompra" ADD CONSTRAINT "GastoAdicionalCompra_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaIngreso" ADD CONSTRAINT "LineaIngreso_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineaIngreso" ADD CONSTRAINT "LineaIngreso_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Las rutas validan entradas; estas restricciones protegen también las escrituras concurrentes.
ALTER TABLE "Ingreso" ADD CONSTRAINT "Ingreso_fechas_check" CHECK ("fechaRecepcion" >= "fechaCompra");
ALTER TABLE "Ingreso" ADD CONSTRAINT "Ingreso_estado_check" CHECK ("estado" IN ('borrador', 'confirmado', 'anulado'));
ALTER TABLE "LineaIngreso" ADD CONSTRAINT "LineaIngreso_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "LineaIngreso" ADD CONSTRAINT "LineaIngreso_costo_check" CHECK ("costoUnitario" >= 0);
ALTER TABLE "GastoAdicionalCompra" ADD CONSTRAINT "GastoAdicionalCompra_importe_check" CHECK ("importe" >= 0);
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_cantidad_check" CHECK ("cantidadOriginal" > 0);
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_costo_check" CHECK ("costoUnitario" IS NULL OR "costoUnitario" >= 0);
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_cantidad_check" CHECK ("cantidad" <> 0);
