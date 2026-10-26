INSERT INTO "ConfiguracionPortadaInicio" ("id", "imagenUrl", "fechaCompletada", "actualizadoEn")
VALUES (1, '/drops/sin-drops.png', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
SET "imagenUrl" = COALESCE("ConfiguracionPortadaInicio"."imagenUrl", EXCLUDED."imagenUrl"),
    "fechaCompletada" = COALESCE("ConfiguracionPortadaInicio"."fechaCompletada", EXCLUDED."fechaCompletada"),
    "actualizadoEn" = CURRENT_TIMESTAMP;
