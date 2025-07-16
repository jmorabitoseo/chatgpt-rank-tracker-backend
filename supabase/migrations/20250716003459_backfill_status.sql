BEGIN;

UPDATE public.tracking_results
SET status = 'fulfilled'
-- only touch rows that aren’t already fulfilled
WHERE status IS DISTINCT FROM 'fulfilled';

COMMIT;