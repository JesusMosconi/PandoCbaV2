-- Preserve legacy orders. New checkout orders use explicit pending-payment state and timestamps.
ALTER TABLE "Orden"
  ALTER COLUMN "costoEnvio" DROP DEFAULT,
  ALTER COLUMN "costoEnvio" DROP NOT NULL,
  ALTER COLUMN "total" DROP NOT NULL;

ALTER TABLE "Orden"
  ADD COLUMN "creadaEn" TIMESTAMPTZ(3),
  ADD COLUMN "venceEn" TIMESTAMPTZ(3),
  ADD COLUMN "claveConfirmacion" TEXT,
  ADD COLUMN "huellaSolicitud" TEXT,
  ADD COLUMN "pagoConfirmadoEn" TIMESTAMPTZ(3),
  ADD COLUMN "pagoConfirmadoPorId" INTEGER,
  ADD COLUMN "envioCoordinadoEn" TIMESTAMPTZ(3),
  ADD COLUMN "envioCoordinadoPorId" INTEGER,
  ADD COLUMN "canceladaEn" TIMESTAMPTZ(3),
  ADD COLUMN "motivoCancelacion" TEXT,
  ADD COLUMN "restituirStock" BOOLEAN;

CREATE UNIQUE INDEX "Orden_usuarioId_claveConfirmacion_key" ON "Orden"("usuarioId", "claveConfirmacion");
CREATE INDEX "Orden_usuarioId_creadaEn_idx" ON "Orden"("usuarioId", "creadaEn");
CREATE INDEX "Orden_estado_venceEn_idx" ON "Orden"("estado", "venceEn");

CREATE TABLE "DetalleOrden" (
  "id" SERIAL NOT NULL,
  "ordenId" INTEGER NOT NULL,
  "posicion" INTEGER NOT NULL,
  "productoId" INTEGER,
  "talleProductoId" INTEGER,
  "nombreProducto" TEXT NOT NULL,
  "talle" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "cantidad" INTEGER NOT NULL,
  "precioUnitario" DECIMAL(65,30) NOT NULL,
  "importeLinea" DECIMAL(65,30) NOT NULL,
  CONSTRAINT "DetalleOrden_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DetalleOrden_cantidad_positiva" CHECK ("cantidad" > 0)
);

CREATE UNIQUE INDEX "DetalleOrden_ordenId_posicion_key" ON "DetalleOrden"("ordenId", "posicion");
ALTER TABLE "DetalleOrden" ADD CONSTRAINT "DetalleOrden_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DetalleOrden" ADD CONSTRAINT "DetalleOrden_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DetalleOrden" ADD CONSTRAINT "DetalleOrden_talleProductoId_fkey" FOREIGN KEY ("talleProductoId") REFERENCES "TalleProducto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReservaStock" (
  "id" SERIAL NOT NULL,
  "ordenId" INTEGER NOT NULL,
  "talleProductoId" INTEGER NOT NULL,
  "cantidad" INTEGER NOT NULL,
  "estado" TEXT NOT NULL,
  "reservadaEn" TIMESTAMPTZ(3) NOT NULL,
  "liberadaEn" TIMESTAMPTZ(3),
  "consumidaEn" TIMESTAMPTZ(3),
  CONSTRAINT "ReservaStock_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReservaStock_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "ReservaStock_estado_valido" CHECK ("estado" IN ('activa', 'liberada', 'consumida'))
);

CREATE UNIQUE INDEX "ReservaStock_ordenId_talleProductoId_key" ON "ReservaStock"("ordenId", "talleProductoId");
CREATE INDEX "ReservaStock_talleProductoId_estado_idx" ON "ReservaStock"("talleProductoId", "estado");
ALTER TABLE "ReservaStock" ADD CONSTRAINT "ReservaStock_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReservaStock" ADD CONSTRAINT "ReservaStock_talleProductoId_fkey" FOREIGN KEY ("talleProductoId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EventoOrden" (
  "id" SERIAL NOT NULL,
  "ordenId" INTEGER NOT NULL,
  "fecha" TIMESTAMPTZ(3) NOT NULL,
  "origen" TEXT NOT NULL,
  "actorUsuarioId" INTEGER,
  "estadoAnterior" TEXT,
  "estadoNuevo" TEXT NOT NULL,
  "motivo" TEXT,
  "restituirStock" BOOLEAN,
  CONSTRAINT "EventoOrden_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EventoOrden_ordenId_fecha_idx" ON "EventoOrden"("ordenId", "fecha");
ALTER TABLE "EventoOrden" ADD CONSTRAINT "EventoOrden_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
