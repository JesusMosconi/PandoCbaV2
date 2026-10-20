-- AlterTable
ALTER TABLE "PartidaInventario" ADD COLUMN     "asignacionOrigenId" INTEGER,
ADD COLUMN     "recepcionClienteId" INTEGER;

-- CreateIndex
CREATE INDEX "PartidaInventario_recepcionClienteId_idx" ON "PartidaInventario"("recepcionClienteId");

-- CreateIndex
CREATE INDEX "PartidaInventario_asignacionOrigenId_idx" ON "PartidaInventario"("asignacionOrigenId");

-- AddForeignKey
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_recepcionClienteId_fkey" FOREIGN KEY ("recepcionClienteId") REFERENCES "RecepcionDevolucion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartidaInventario" ADD CONSTRAINT "PartidaInventario_asignacionOrigenId_fkey" FOREIGN KEY ("asignacionOrigenId") REFERENCES "AsignacionPartida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
