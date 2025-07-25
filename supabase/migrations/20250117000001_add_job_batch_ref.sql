-- Add job_batch_id reference to tracking_results
ALTER TABLE public.tracking_results
  ADD COLUMN job_batch_id UUID REFERENCES public.job_batches(id) ON DELETE CASCADE;

-- Add index for performance
CREATE INDEX idx_tracking_results_job_batch_id ON public.tracking_results(job_batch_id);

-- Add batch_number to track which batch within a job this result belongs to
ALTER TABLE public.tracking_results
  ADD COLUMN batch_number INTEGER; 