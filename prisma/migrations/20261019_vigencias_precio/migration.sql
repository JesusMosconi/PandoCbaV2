-- La primera vigencia es una observación al aplicar esta migración; no reconstruye precios anteriores.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "VigenciaPrecio" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "clase" TEXT NOT NULL,
    "importe" DECIMAL(65,30) NOT NULL,
    "inicio" TIMESTAMPTZ(3) NOT NULL,
    "fin" TIMESTAMPTZ(3),
    "origen" TEXT NOT NULL,
    CONSTRAINT "VigenciaPrecio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VigenciaPrecio_clase_check" CHECK ("clase" IN ('regular', 'promocional')),
    CONSTRAINT "VigenciaPrecio_importe_check" CHECK ("importe" >= 0),
    CONSTRAINT "VigenciaPrecio_intervalo_check" CHECK ("fin" IS NULL OR "fin" > "inicio")
);

CREATE INDEX "VigenciaPrecio_productoId_clase_inicio_idx"
    ON "VigenciaPrecio"("productoId", "clase", "inicio");

ALTER TABLE "VigenciaPrecio" ADD CONSTRAINT "VigenciaPrecio_productoId_fkey"
    FOREIGN KEY ("productoId") REFERENCES "Producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "VigenciaPrecio" ("productoId", "clase", "importe", "inicio", "origen")
SELECT "id", 'regular', "precio", clock_timestamp(), 'observado_al_activar'
FROM "Producto" WHERE "activo" = true AND "web" = true;

ALTER TABLE "VigenciaPrecio" ADD CONSTRAINT "VigenciaPrecio_sin_solapamiento"
    EXCLUDE USING GIST (
        "productoId" WITH =,
        "clase" WITH =,
        tstzrange("inicio", COALESCE("fin", 'infinity'::timestamptz), '[)') WITH &&
    );
