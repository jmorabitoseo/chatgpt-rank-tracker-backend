-- add the new column with default
ALTER TABLE public.tracking_results
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

-- backfill existing rows as fulfilled
UPDATE public.tracking_results
  SET status = 'fulfilled'
  WHERE snapshot_id IS NOT NULL;