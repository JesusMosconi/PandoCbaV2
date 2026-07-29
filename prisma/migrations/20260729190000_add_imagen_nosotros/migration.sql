CREATE TABLE "ImagenNosotros" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "imagenUrl" TEXT,

    CONSTRAINT "ImagenNosotros_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImagenNosotros_clave_key" ON "ImagenNosotros"("clave");

INSERT INTO "ImagenNosotros" ("clave", "nombre", "orden")
VALUES
    ('principal', 'Imagen principal', 1),
    ('proceso-1', 'Materia prima', 2),
    ('proceso-2', 'La maestría en el detalle', 3),
    ('proceso-3', 'Edición limitada', 4);
