BEGIN;

-- AlterTable
ALTER TABLE "PagoReintegro" ADD COLUMN     "comprobadoEn" TIMESTAMPTZ(3),
ADD COLUMN     "referenciaExterna" TEXT;

-- AlterTable
ALTER TABLE "Orden" ADD COLUMN     "domicilioRevisadoEn" TIMESTAMPTZ(3),
ADD COLUMN     "domicilioRevisadoPorId" INTEGER,
ADD COLUMN     "esDemostracion" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "IntentoPago" (
    "id" SERIAL NOT NULL,
    "ordenId" INTEGER NOT NULL,
    "proveedor" TEXT NOT NULL DEFAULT 'mercado_pago',
    "claveIdempotencia" TEXT NOT NULL,
    "referenciaExterna" TEXT,
    "importe" DECIMAL(14,2) NOT NULL,
    "moneda" TEXT NOT NULL DEFAULT 'ARS',
    "estado" TEXT NOT NULL DEFAULT 'preparado',
    "urlCheckout" TEXT,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMPTZ(3) NOT NULL,
    "ultimoChequeoEn" TIMESTAMPTZ(3),

    CONSTRAINT "IntentoPago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidenciaPago" (
    "id" SERIAL NOT NULL,
    "ordenId" INTEGER NOT NULL,
    "intentoId" INTEGER,
    "claveHallazgo" TEXT NOT NULL,
    "referenciaExterna" TEXT,
    "tipo" TEXT NOT NULL,
    "importe" DECIMAL(14,2),
    "moneda" TEXT NOT NULL DEFAULT 'ARS',
    "estado" TEXT NOT NULL DEFAULT 'abierta',
    "detectadaEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resueltaEn" TIMESTAMPTZ(3),
    "actorUsuarioId" INTEGER,
    "resolucion" TEXT,

    CONSTRAINT "IncidenciaPago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReintegroPago" (
    "id" SERIAL NOT NULL,
    "ordenId" INTEGER NOT NULL,
    "incidenciaId" INTEGER,
    "claveOperacion" TEXT NOT NULL,
    "concepto" TEXT NOT NULL,
    "importeDebido" DECIMAL(14,2) NOT NULL,
    "importeReintegrado" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "referenciaExterna" TEXT,
    "metodo" TEXT,
    "motivo" TEXT,
    "actorUsuarioId" INTEGER,
    "creadoEn" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comprobadoEn" TIMESTAMPTZ(3),

    CONSTRAINT "ReintegroPago_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntentoPago_claveIdempotencia_key" ON "IntentoPago"("claveIdempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "IntentoPago_referenciaExterna_key" ON "IntentoPago"("referenciaExterna");

-- CreateIndex
CREATE INDEX "IntentoPago_ordenId_creadoEn_idx" ON "IntentoPago"("ordenId", "creadoEn");

-- CreateIndex
CREATE INDEX "IntentoPago_estado_ultimoChequeoEn_idx" ON "IntentoPago"("estado", "ultimoChequeoEn");

-- CreateIndex
CREATE UNIQUE INDEX "IncidenciaPago_claveHallazgo_key" ON "IncidenciaPago"("claveHallazgo");

-- CreateIndex
CREATE INDEX "IncidenciaPago_ordenId_estado_idx" ON "IncidenciaPago"("ordenId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "ReintegroPago_claveOperacion_key" ON "ReintegroPago"("claveOperacion");

-- CreateIndex
CREATE UNIQUE INDEX "ReintegroPago_referenciaExterna_key" ON "ReintegroPago"("referenciaExterna");

-- CreateIndex
CREATE INDEX "ReintegroPago_ordenId_estado_idx" ON "ReintegroPago"("ordenId", "estado");

-- AddForeignKey
ALTER TABLE "IntentoPago" ADD CONSTRAINT "IntentoPago_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidenciaPago" ADD CONSTRAINT "IncidenciaPago_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidenciaPago" ADD CONSTRAINT "IncidenciaPago_intentoId_fkey" FOREIGN KEY ("intentoId") REFERENCES "IntentoPago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReintegroPago" ADD CONSTRAINT "ReintegroPago_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "Orden"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReintegroPago" ADD CONSTRAINT "ReintegroPago_incidenciaId_fkey" FOREIGN KEY ("incidenciaId") REFERENCES "IncidenciaPago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariantes monetarias y exclusión de intentos abiertos concurrentes.
ALTER TABLE "IntentoPago" ADD CONSTRAINT "IntentoPago_datos_validos"
CHECK ("importe" > 0 AND "moneda" = 'ARS' AND "proveedor" = 'mercado_pago'
 AND "estado" IN ('preparado','creacion_incierta','abierto','aprobado','rechazado','cancelado','vencido','incidencia'));
CREATE UNIQUE INDEX "IntentoPago_un_abierto_por_orden" ON "IntentoPago"("ordenId")
WHERE "estado" IN ('preparado','creacion_incierta','abierto');
ALTER TABLE "IncidenciaPago" ADD CONSTRAINT "IncidenciaPago_datos_validos"
CHECK ("estado" IN ('abierta','resuelta') AND "moneda" = 'ARS'
 AND ("importe" IS NULL OR "importe" >= 0)
 AND "tipo" IN ('cobro_tardio','importe_incorrecto','referencia_incorrecta','cobro_duplicado','resultado_incierto','reconocimiento_fallido'));
ALTER TABLE "ReintegroPago" ADD CONSTRAINT "ReintegroPago_datos_validos"
CHECK ("concepto" IN ('envio','cobro_sin_venta') AND "importeDebido" >= 0
 AND "importeReintegrado" >= 0 AND "importeReintegrado" <= "importeDebido"
 AND "estado" IN ('pendiente','en_proceso','completado','fallido')
 AND ("estado" <> 'completado' OR ("comprobadoEn" IS NOT NULL AND "referenciaExterna" IS NOT NULL
 AND "actorUsuarioId" IS NOT NULL AND "importeReintegrado" = "importeDebido")));
ALTER TABLE "Orden" ADD CONSTRAINT "Orden_pago_tesis_valido"
CHECK ("metodoPago" <> 'mercado_pago' OR ("esDemostracion" AND "total" IS NOT NULL
 AND "costoEnvio" IS NOT NULL AND "total" = "subtotal" + "costoEnvio"));

COMMIT;
