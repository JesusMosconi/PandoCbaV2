-- CreateTable
CREATE TABLE "AsignacionPartida" (
    "id" SERIAL NOT NULL,
    "partidaId" INTEGER NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "detalleOrdenId" INTEGER NOT NULL,
    "reservaStockId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'reservada',
    "costoUnitarioAlPago" DECIMAL(14,2),
    "importeEfectivo" DECIMAL(14,2),
    "descuentoAtribuido" DECIMAL(14,2),
    "reservadaEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendidaEn" TIMESTAMPTZ(3),
    "liberadaEn" TIMESTAMPTZ(3),
    "revertidaEn" TIMESTAMPTZ(3),

    CONSTRAINT "AsignacionPartida_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AsignacionPartida_varianteId_estado_partidaId_idx" ON "AsignacionPartida"("varianteId", "estado", "partidaId");

-- CreateIndex
CREATE INDEX "AsignacionPartida_partidaId_estado_idx" ON "AsignacionPartida"("partidaId", "estado");

-- CreateIndex
CREATE INDEX "AsignacionPartida_reservaStockId_estado_idx" ON "AsignacionPartida"("reservaStockId", "estado");

-- CreateIndex
CREATE INDEX "AsignacionPartida_detalleOrdenId_estado_idx" ON "AsignacionPartida"("detalleOrdenId", "estado");

-- AddForeignKey
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_detalleOrdenId_fkey" FOREIGN KEY ("detalleOrdenId") REFERENCES "DetalleOrden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_reservaStockId_fkey" FOREIGN KEY ("reservaStockId") REFERENCES "ReservaStock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_estado_check" CHECK ("estado" IN ('reservada', 'vendida', 'liberada', 'revertida'));
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_costo_check" CHECK ("costoUnitarioAlPago" IS NULL OR "costoUnitarioAlPago" >= 0);
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_importe_check" CHECK ("importeEfectivo" IS NULL OR "importeEfectivo" >= 0);
ALTER TABLE "AsignacionPartida" ADD CONSTRAINT "AsignacionPartida_descuento_check" CHECK ("descuentoAtribuido" IS NULL OR "descuentoAtribuido" >= 0);
