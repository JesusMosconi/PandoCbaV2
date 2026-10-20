-- CreateTable
CREATE TABLE "CorreccionIngreso" (
    "id" SERIAL NOT NULL,
    "ingresoId" INTEGER NOT NULL,
    "partidaId" INTEGER NOT NULL,
    "campo" TEXT NOT NULL,
    "valorAnterior" JSONB NOT NULL,
    "valorNuevo" JSONB NOT NULL,
    "diferenciaCosto" DECIMAL(14,2),
    "motivo" TEXT NOT NULL,
    "claveOperacion" TEXT NOT NULL,
    "actorUsuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorreccionIngreso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevolucionProveedor" (
    "id" SERIAL NOT NULL,
    "ingresoId" INTEGER NOT NULL,
    "partidaId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "importeRevertido" DECIMAL(14,2) NOT NULL,
    "motivo" TEXT NOT NULL,
    "claveOperacion" TEXT NOT NULL,
    "actorUsuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevolucionProveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevolucionCliente" (
    "id" SERIAL NOT NULL,
    "ordenId" INTEGER NOT NULL,
    "detalleOrdenId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "importeDebido" DECIMAL(14,2) NOT NULL,
    "costoRevertido" DECIMAL(14,2),
    "unidadesCostoDesconocido" INTEGER NOT NULL DEFAULT 0,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "motivo" TEXT NOT NULL,
    "motivoCierre" TEXT,
    "claveOperacion" TEXT NOT NULL,
    "huellaSolicitud" TEXT NOT NULL,
    "claveCierre" TEXT,
    "actorUsuarioId" INTEGER NOT NULL,
    "cerradoPorId" INTEGER,
    "aceptadaEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerradoEn" TIMESTAMPTZ(3),

    CONSTRAINT "DevolucionCliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevolucionClienteAsignacion" (
    "id" SERIAL NOT NULL,
    "devolucionId" INTEGER NOT NULL,
    "asignacionId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "importeEfectivo" DECIMAL(14,2) NOT NULL,
    "costoRevertido" DECIMAL(14,2),

    CONSTRAINT "DevolucionClienteAsignacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagoReintegro" (
    "id" SERIAL NOT NULL,
    "devolucionId" INTEGER NOT NULL,
    "importeEfectivo" DECIMAL(14,2) NOT NULL,
    "claveOperacion" TEXT NOT NULL,
    "actorUsuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PagoReintegro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecepcionDevolucion" (
    "id" SERIAL NOT NULL,
    "devolucionId" INTEGER NOT NULL,
    "partidaId" INTEGER,
    "cantidadApta" INTEGER NOT NULL,
    "cantidadDanada" INTEGER NOT NULL,
    "motivo" TEXT,
    "claveOperacion" TEXT NOT NULL,
    "actorUsuarioId" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecepcionDevolucion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorreccionIngreso_claveOperacion_key" ON "CorreccionIngreso"("claveOperacion");

-- CreateIndex
CREATE INDEX "CorreccionIngreso_ingresoId_fecha_idx" ON "CorreccionIngreso"("ingresoId", "fecha");

-- CreateIndex
CREATE INDEX "CorreccionIngreso_partidaId_fecha_idx" ON "CorreccionIngreso"("partidaId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "DevolucionProveedor_claveOperacion_key" ON "DevolucionProveedor"("claveOperacion");

-- CreateIndex
CREATE INDEX "DevolucionProveedor_ingresoId_fecha_idx" ON "DevolucionProveedor"("ingresoId", "fecha");

-- CreateIndex
CREATE INDEX "DevolucionProveedor_partidaId_fecha_idx" ON "DevolucionProveedor"("partidaId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "DevolucionCliente_claveCierre_key" ON "DevolucionCliente"("claveCierre");
CREATE UNIQUE INDEX "DevolucionCliente_claveOperacion_detalleOrdenId_key" ON "DevolucionCliente"("claveOperacion", "detalleOrdenId");

-- CreateIndex
CREATE INDEX "DevolucionCliente_ordenId_aceptadaEn_idx" ON "DevolucionCliente"("ordenId", "aceptadaEn");

-- CreateIndex
CREATE INDEX "DevolucionCliente_detalleOrdenId_aceptadaEn_idx" ON "DevolucionCliente"("detalleOrdenId", "aceptadaEn");

-- CreateIndex
CREATE INDEX "DevolucionClienteAsignacion_asignacionId_idx" ON "DevolucionClienteAsignacion"("asignacionId");

-- CreateIndex
CREATE UNIQUE INDEX "DevolucionClienteAsignacion_devolucionId_asignacionId_key" ON "DevolucionClienteAsignacion"("devolucionId", "asignacionId");

-- CreateIndex
CREATE UNIQUE INDEX "PagoReintegro_claveOperacion_key" ON "PagoReintegro"("claveOperacion");

-- CreateIndex
CREATE INDEX "PagoReintegro_devolucionId_fecha_idx" ON "PagoReintegro"("devolucionId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "RecepcionDevolucion_claveOperacion_key" ON "RecepcionDevolucion"("claveOperacion");

-- CreateIndex
CREATE INDEX "RecepcionDevolucion_devolucionId_fecha_idx" ON "RecepcionDevolucion"("devolucionId", "fecha");

-- AddForeignKey
ALTER TABLE "CorreccionIngreso" ADD CONSTRAINT "CorreccionIngreso_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorreccionIngreso" ADD CONSTRAINT "CorreccionIngreso_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionProveedor" ADD CONSTRAINT "DevolucionProveedor_ingresoId_fkey" FOREIGN KEY ("ingresoId") REFERENCES "Ingreso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionProveedor" ADD CONSTRAINT "DevolucionProveedor_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionCliente" ADD CONSTRAINT "DevolucionCliente_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionCliente" ADD CONSTRAINT "DevolucionCliente_detalleOrdenId_fkey" FOREIGN KEY ("detalleOrdenId") REFERENCES "DetalleOrden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionClienteAsignacion" ADD CONSTRAINT "DevolucionClienteAsignacion_devolucionId_fkey" FOREIGN KEY ("devolucionId") REFERENCES "DevolucionCliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevolucionClienteAsignacion" ADD CONSTRAINT "DevolucionClienteAsignacion_asignacionId_fkey" FOREIGN KEY ("asignacionId") REFERENCES "AsignacionPartida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoReintegro" ADD CONSTRAINT "PagoReintegro_devolucionId_fkey" FOREIGN KEY ("devolucionId") REFERENCES "DevolucionCliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecepcionDevolucion" ADD CONSTRAINT "RecepcionDevolucion_devolucionId_fkey" FOREIGN KEY ("devolucionId") REFERENCES "DevolucionCliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecepcionDevolucion" ADD CONSTRAINT "RecepcionDevolucion_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las cantidades y pagos no admiten efectos nulos o negativos.
ALTER TABLE "DevolucionProveedor" ADD CONSTRAINT "DevolucionProveedor_cantidad_check" CHECK ("cantidad" > 0 AND "importeRevertido" >= 0);
ALTER TABLE "DevolucionCliente" ADD CONSTRAINT "DevolucionCliente_cantidad_check" CHECK ("cantidad" > 0 AND "importeDebido" >= 0 AND "unidadesCostoDesconocido" >= 0);
ALTER TABLE "DevolucionClienteAsignacion" ADD CONSTRAINT "DevolucionClienteAsignacion_cantidad_check" CHECK ("cantidad" > 0 AND "importeEfectivo" >= 0);
ALTER TABLE "PagoReintegro" ADD CONSTRAINT "PagoReintegro_importe_check" CHECK ("importeEfectivo" > 0);
ALTER TABLE "RecepcionDevolucion" ADD CONSTRAINT "RecepcionDevolucion_cantidad_check" CHECK ("cantidadApta" >= 0 AND "cantidadDanada" >= 0 AND "cantidadApta" + "cantidadDanada" > 0);
