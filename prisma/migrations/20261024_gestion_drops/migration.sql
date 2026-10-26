ALTER TABLE "Coleccion"
  ADD COLUMN "fechaFinalizacion" TIMESTAMP(3),
  ADD COLUMN "tituloInicio" TEXT,
  ADD COLUMN "textoBotonInicio" TEXT,
  ADD COLUMN "fechaActivacion" TIMESTAMP(3),
  ADD COLUMN "fechaCierre" TIMESTAMP(3),
  ADD COLUMN "motivoCierre" TEXT,
  ADD COLUMN "activo" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "ConfiguracionPortadaInicio" (
  "id" INTEGER NOT NULL,
  "titulo" TEXT,
  "imagenUrl" TEXT,
  "fechaCompletada" TIMESTAMP(3),
  "actualizadoEn" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConfiguracionPortadaInicio_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConfiguracionPortadaInicio_id_check" CHECK ("id" = 1)
);

ALTER TABLE "Coleccion" ADD CONSTRAINT "Coleccion_fechas_drop_check"
  CHECK ("fechaFinalizacion" IS NULL OR ("fechaLanzamiento" IS NOT NULL AND "fechaFinalizacion" > "fechaLanzamiento"));
ALTER TABLE "Coleccion" ADD CONSTRAINT "Coleccion_motivo_cierre_check"
  CHECK ("motivoCierre" IS NULL OR "motivoCierre" IN ('manual', 'reemplazo'));
