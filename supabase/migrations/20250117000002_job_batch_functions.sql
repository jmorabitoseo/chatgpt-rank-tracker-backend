-- Function to atomically increment completed_batches
CREATE OR REPLACE FUNCTION increment_completed_batches(job_id UUID)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE public.job_batches 
  SET completed_batches = completed_batches + 1
  WHERE id = job_id
  RETURNING completed_batches INTO new_count;
  
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- Function to atomically increment failed_batches  
CREATE OR REPLACE FUNCTION increment_failed_batches(job_id UUID)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE public.job_batches 
  SET failed_batches = failed_batches + 1
  WHERE id = job_id
  RETURNING failed_batches INTO new_count;
  
  RETURN new_count;
END;
$$ LANGUAGE plpgsql; 