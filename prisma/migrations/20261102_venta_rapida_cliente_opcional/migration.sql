-- 007 (cambio 2026-11-02): venta rápida y datos opcionales del cliente en lugar del DNI.
-- La migración 20261029_vendedor_venta_local ya está aplicada y no se edita.

-- El DNI deja de pedirse y de guardarse; el canal local exige solo caja y comprobante.
ALTER TABLE "Orden" DROP CONSTRAINT "Orden_datos_local_check";
ALTER TABLE "Orden" DROP COLUMN "dniCliente";
ALTER TABLE "Orden"
  ADD COLUMN "nombreCliente" TEXT,
  ADD COLUMN "telefonoCliente" TEXT;
ALTER TABLE "Orden" ADD CONSTRAINT "Orden_datos_local_check" CHECK (
  "canal" = 'web' OR ("cajaId" IS NOT NULL AND "numeroComprobante" IS NOT NULL)
);
ALTER TABLE "Orden" ADD CONSTRAINT "Orden_cliente_local_check" CHECK (
  ("nombreCliente" IS NULL OR char_length("nombreCliente") BETWEEN 1 AND 100)
  AND ("telefonoCliente" IS NULL OR "telefonoCliente" ~ '^\+?[0-9]{6,20}$')
);

-- Línea de venta rápida: concepto e importe sin variante ni producto improvisado.
ALTER TABLE "ItemCarrito" ADD COLUMN "concepto" TEXT;
ALTER TABLE "ItemCarrito" ADD CONSTRAINT "ItemCarrito_venta_rapida_check" CHECK (
  "concepto" IS NULL
  OR ("talleProductoId" IS NULL AND "productoImprovisadoId" IS NULL AND char_length("concepto") BETWEEN 1 AND 80)
);
