-- 007: vendedor y venta en local. Migración aditiva: no borra ni reescribe datos.

-- Disponibilidad en el local, independiente de la publicación web.
-- Los productos existentes quedan disponibles en el local.
ALTER TABLE "Producto" ADD COLUMN "local" BOOLEAN NOT NULL DEFAULT true;

-- Caja única del local.
CREATE TABLE "Caja" (
  "id" SERIAL NOT NULL,
  "estado" TEXT NOT NULL DEFAULT 'abierta',
  "efectivoInicial" DECIMAL(14,2) NOT NULL,
  "abiertaEn" TIMESTAMPTZ(3) NOT NULL,
  "abiertaPorId" INTEGER NOT NULL,
  "claveApertura" TEXT,
  "cerradaEn" TIMESTAMPTZ(3),
  "cerradaPorId" INTEGER,
  "cantidadVentas" INTEGER,
  "totalesPorMedio" JSONB,
  "totalVentas" DECIMAL(14,2),
  "efectivoEsperado" DECIMAL(14,2),
  "efectivoDeclarado" DECIMAL(14,2),
  "diferencia" DECIMAL(14,2),
  "observacion" TEXT,
  CONSTRAINT "Caja_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Caja_estado_check" CHECK ("estado" IN ('abierta', 'cerrada')),
  CONSTRAINT "Caja_efectivo_inicial_check" CHECK ("efectivoInicial" >= 0),
  CONSTRAINT "Caja_efectivo_declarado_check" CHECK ("efectivoDeclarado" IS NULL OR "efectivoDeclarado" >= 0),
  CONSTRAINT "Caja_cierre_completo_check" CHECK (
    "estado" = 'abierta'
    OR ("cerradaEn" IS NOT NULL AND "efectivoDeclarado" IS NOT NULL
      AND "efectivoEsperado" IS NOT NULL AND "diferencia" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "Caja_claveApertura_key" ON "Caja"("claveApertura");
CREATE INDEX "Caja_estado_abiertaEn_idx" ON "Caja"("estado", "abiertaEn");
-- Solo una caja abierta a la vez (índice parcial, no representable en schema.prisma).
CREATE UNIQUE INDEX "Caja_una_abierta" ON "Caja" ((true)) WHERE "estado" = 'abierta';

-- Canal de venta y datos propios de la venta en local.
ALTER TABLE "Orden"
  ADD COLUMN "canal" TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN "dniCliente" TEXT,
  ADD COLUMN "cajaId" INTEGER,
  ADD COLUMN "numeroComprobante" INTEGER;

ALTER TABLE "Orden" ADD CONSTRAINT "Orden_canal_check" CHECK ("canal" IN ('web', 'local'));
ALTER TABLE "Orden" ADD CONSTRAINT "Orden_datos_local_check" CHECK (
  "canal" = 'web'
  OR ("dniCliente" ~ '^[0-9]{7,8}$' AND "cajaId" IS NOT NULL AND "numeroComprobante" IS NOT NULL)
);

CREATE UNIQUE INDEX "Orden_numeroComprobante_key" ON "Orden"("numeroComprobante");
CREATE INDEX "Orden_canal_pagoConfirmadoEn_idx" ON "Orden"("canal", "pagoConfirmadoEn");
CREATE INDEX "Orden_cajaId_idx" ON "Orden"("cajaId");

ALTER TABLE "Orden" ADD CONSTRAINT "Orden_cajaId_fkey"
  FOREIGN KEY ("cajaId") REFERENCES "Caja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un único vendedor activo (índice parcial, no representable en schema.prisma).
CREATE UNIQUE INDEX "Usuario_vendedor_activo_unico" ON "Usuario" ("rol")
  WHERE "rol" = 'vendedor' AND "activo" = true;
