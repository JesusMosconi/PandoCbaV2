-- CreateTable
CREATE TABLE "EstadoCorteInventario" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "iniciadoEn" TIMESTAMPTZ(3),
    "conciliadoEn" TIMESTAMPTZ(3),
    "activadoEn" TIMESTAMPTZ(3),
    "rutasVerificadasEn" TIMESTAMPTZ(3),
    "rutasVerificadasPorId" INTEGER,
    "activadoPorId" INTEGER,
    "suspendido" BOOLEAN NOT NULL DEFAULT false,
    "actualizadoEn" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EstadoCorteInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstadoCorteVariante" (
    "id" SERIAL NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "corteId" INTEGER NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "origen" TEXT,
    "saldoCapturado" INTEGER,
    "comprometido" INTEGER,
    "diferencia" INTEGER,
    "motivo" TEXT,
    "conciliadoEn" TIMESTAMPTZ(3),
    "conciliadoPorId" INTEGER,

    CONSTRAINT "EstadoCorteVariante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExistenciaInicial" (
    "id" SERIAL NOT NULL,
    "varianteId" INTEGER NOT NULL,
    "estadoVarianteId" INTEGER NOT NULL,
    "partidaId" INTEGER NOT NULL,
    "movimientoId" INTEGER NOT NULL,
    "saldoFisico" INTEGER NOT NULL,
    "costoUnitario" DECIMAL(14,2),
    "capturadoEn" TIMESTAMPTZ(3) NOT NULL,
    "actorUsuarioId" INTEGER NOT NULL,

    CONSTRAINT "ExistenciaInicial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EstadoCorteVariante_varianteId_key" ON "EstadoCorteVariante"("varianteId");

-- CreateIndex
CREATE INDEX "EstadoCorteVariante_corteId_estado_idx" ON "EstadoCorteVariante"("corteId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "ExistenciaInicial_varianteId_key" ON "ExistenciaInicial"("varianteId");

-- CreateIndex
CREATE UNIQUE INDEX "ExistenciaInicial_estadoVarianteId_key" ON "ExistenciaInicial"("estadoVarianteId");

-- CreateIndex
CREATE UNIQUE INDEX "ExistenciaInicial_partidaId_key" ON "ExistenciaInicial"("partidaId");

-- CreateIndex
CREATE UNIQUE INDEX "ExistenciaInicial_movimientoId_key" ON "ExistenciaInicial"("movimientoId");

-- AddForeignKey
ALTER TABLE "EstadoCorteVariante" ADD CONSTRAINT "EstadoCorteVariante_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstadoCorteVariante" ADD CONSTRAINT "EstadoCorteVariante_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "EstadoCorteInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "TalleProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_estadoVarianteId_fkey" FOREIGN KEY ("estadoVarianteId") REFERENCES "EstadoCorteVariante"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_partidaId_fkey" FOREIGN KEY ("partidaId") REFERENCES "PartidaInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_movimientoId_fkey" FOREIGN KEY ("movimientoId") REFERENCES "MovimientoInventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EstadoCorteInventario" ADD CONSTRAINT "EstadoCorteInventario_unico_check" CHECK ("id" = 1);
ALTER TABLE "EstadoCorteInventario" ADD CONSTRAINT "EstadoCorteInventario_estado_check" CHECK ("estado" IN ('pendiente', 'conciliado', 'activo'));
ALTER TABLE "EstadoCorteInventario" ADD CONSTRAINT "EstadoCorteInventario_rutas_check" CHECK (
    ("rutasVerificadasEn" IS NULL AND "rutasVerificadasPorId" IS NULL)
    OR ("rutasVerificadasEn" IS NOT NULL AND "rutasVerificadasPorId" IS NOT NULL)
);
ALTER TABLE "EstadoCorteInventario" ADD CONSTRAINT "EstadoCorteInventario_activacion_check" CHECK (
    "estado" <> 'activo' OR (
        "activadoEn" IS NOT NULL AND "activadoPorId" IS NOT NULL
        AND "rutasVerificadasEn" IS NOT NULL AND "suspendido" = false
    )
);
ALTER TABLE "EstadoCorteVariante" ADD CONSTRAINT "EstadoCorteVariante_estado_check" CHECK ("estado" IN ('pendiente', 'conciliado', 'bloqueado'));
ALTER TABLE "EstadoCorteVariante" ADD CONSTRAINT "EstadoCorteVariante_origen_check" CHECK ("origen" IS NULL OR "origen" IN ('inicial', 'nueva'));
ALTER TABLE "EstadoCorteVariante" ADD CONSTRAINT "EstadoCorteVariante_saldos_check" CHECK (
    ("saldoCapturado" IS NULL OR "saldoCapturado" >= 0)
    AND ("comprometido" IS NULL OR "comprometido" >= 0)
);
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_saldo_check" CHECK ("saldoFisico" > 0);
ALTER TABLE "ExistenciaInicial" ADD CONSTRAINT "ExistenciaInicial_costo_check" CHECK ("costoUnitario" IS NULL OR "costoUnitario" >= 0);
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_ajuste_motivo_check" CHECK (
    "tipo" NOT IN ('ajuste_positivo', 'ajuste_negativo')
    OR ("motivo" IS NOT NULL AND length(btrim("motivo")) > 0 AND "actorUsuarioId" IS NOT NULL)
);
