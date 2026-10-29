-- Velocidad del aire (m/s) medida por anemómetro en el nodo o en una
-- estación fija. Columna opcional: los nodos sin anemómetro guardan NULL.
BEGIN;

ALTER TABLE lecturas
ADD COLUMN IF NOT EXISTS velocidad_aire DOUBLE PRECISION;

COMMIT;
