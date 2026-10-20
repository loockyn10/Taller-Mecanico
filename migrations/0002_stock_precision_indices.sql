-- Fierro · 0002 · Precisión del stock, datos de reposición/costos e índices de lectura.
-- Migración ADITIVA: no elimina ni reescribe estructuras; sólo normaliza decimales y agrega columnas con valor por defecto.

-- E-14: el stock es REAL y se opera siempre redondeado a 3 decimales (ver worker/lib/stock.ts).
-- Se normalizan los valores existentes (p. ej. 0.19999999999999998 → 0.2).
UPDATE articulos SET stock = ROUND(stock, 3), stock_minimo = ROUND(stock_minimo, 3);
UPDATE stock_movimientos SET cantidad = ROUND(cantidad, 3), stock_resultante = ROUND(stock_resultante, 3);

-- Reposición: stock "ideal" opcional (si es NULL se sugiere reponer hasta el doble del mínimo).
ALTER TABLE articulos ADD COLUMN stock_objetivo REAL;

-- Compras: se conserva el costo previo para poder revertirlo al anular la compra.
ALTER TABLE compra_items ADD COLUMN costo_anterior INTEGER;
ALTER TABLE compra_items ADD COLUMN costo_aplicado INTEGER NOT NULL DEFAULT 0;

-- Índices de lectura (hallazgo F-02 de la auditoría).
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(taller_id, fecha);
CREATE INDEX IF NOT EXISTS idx_cobros_fecha ON cobros(taller_id, fecha);
CREATE INDEX IF NOT EXISTS idx_compras_fecha ON compras(taller_id, fecha);
CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON compras(taller_id, proveedor_id);
CREATE INDEX IF NOT EXISTS idx_pagos_proveedor_prov ON pagos_proveedor(taller_id, proveedor_id);
CREATE INDEX IF NOT EXISTS idx_pagos_proveedor_fecha ON pagos_proveedor(taller_id, fecha);
CREATE INDEX IF NOT EXISTS idx_presupuestos_estado ON presupuestos(taller_id, estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_cliente ON ordenes(taller_id, cliente_id);

-- Pagos a proveedor generados al registrar una compra de contado (permite anularlos junto con la compra).
ALTER TABLE pagos_proveedor ADD COLUMN compra_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pagos_proveedor_compra ON pagos_proveedor(taller_id, compra_id) WHERE compra_id IS NOT NULL;
