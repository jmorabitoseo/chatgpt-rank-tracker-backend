-- Create job_batches table to track overall job progress
CREATE TABLE public.job_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID NOT NULL,
  email TEXT NOT NULL,
  total_prompts INTEGER NOT NULL,
  total_batches INTEGER NOT NULL,
  completed_batches INTEGER DEFAULT 0,
  failed_batches INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  openai_key TEXT NOT NULL,
  openai_model TEXT DEFAULT 'gpt-4',
  web_search BOOLEAN DEFAULT false,
  user_country TEXT,
  user_city TEXT,
  brand_mentions TEXT[],
  domain_mentions TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

-- Add indexes for performance
CREATE INDEX idx_job_batches_user_id ON public.job_batches(user_id);
CREATE INDEX idx_job_batches_project_id ON public.job_batches(project_id);
CREATE INDEX idx_job_batches_status ON public.job_batches(status);
CREATE INDEX idx_job_batches_created_at ON public.job_batches(created_at);

-- Add RLS policies (assuming you have RLS enabled)
ALTER TABLE public.job_batches ENABLE ROW LEVEL SECURITY;

-- Policy to allow users to see their own job batches
CREATE POLICY "Users can view own job batches" ON public.job_batches
  FOR SELECT USING (auth.uid() = user_id);

-- Policy to allow users to insert their own job batches  
CREATE POLICY "Users can insert own job batches" ON public.job_batches
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policy to allow system to update job batches (for worker updates)
CREATE POLICY "System can update job batches" ON public.job_batches
  FOR UPDATE USING (true); 