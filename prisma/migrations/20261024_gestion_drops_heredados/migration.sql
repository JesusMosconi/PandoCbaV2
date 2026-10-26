-- Preserva en el drop futuro inventariado los textos que Inicio ya mostraba.
-- Si el registro cambió desde la auditoría, no supone que sigue siendo el mismo.
UPDATE "Coleccion"
SET "tituloInicio" = E'NO SIGAS TENDENCIAS.\nCREALAS.',
    "textoBotonInicio" = 'IR A LA COLECCIÓN'
WHERE "id" = 1
  AND "nombre" = 'Drop'
  AND "fechaLanzamiento" = TIMESTAMP '2026-11-18 00:00:00'
  AND "imagenUrl" IS NOT NULL
  AND "tituloInicio" IS NULL
  AND "textoBotonInicio" IS NULL;
