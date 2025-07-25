-- Fix RLS policies for job_batches table in staging
-- Run this in your Supabase SQL Editor

-- First, check if RLS is enabled and what policies exist
SELECT 
  t.schemaname, 
  t.tablename, 
  t.rowsecurity, 
  p.policyname, 
  p.permissive, 
  p.roles, 
  p.cmd, 
  p.qual, 
  p.with_check
FROM pg_tables t
LEFT JOIN pg_policies p ON p.schemaname = t.schemaname AND p.tablename = t.tablename
WHERE t.tablename = 'job_batches';

-- Option 1: Temporarily disable RLS for testing (ONLY for staging/testing)
-- ALTER TABLE public.job_batches DISABLE ROW LEVEL SECURITY;

-- Option 2: Create more permissive policies (recommended for server-side inserts)

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own job batches" ON public.job_batches;
DROP POLICY IF EXISTS "Users can insert own job batches" ON public.job_batches;
DROP POLICY IF EXISTS "System can update job batches" ON public.job_batches;
DROP POLICY IF EXISTS "Allow service role access" ON public.job_batches;

-- Create new policies that work with both authenticated users and service role
CREATE POLICY "Users can view own job batches" ON public.job_batches
  FOR SELECT USING (
    auth.uid() = user_id OR 
    auth.role() = 'service_role'
  );

CREATE POLICY "Users can insert own job batches" ON public.job_batches
  FOR INSERT WITH CHECK (
    auth.uid() = user_id OR 
    auth.role() = 'service_role'
  );

CREATE POLICY "Allow updates on job batches" ON public.job_batches
  FOR UPDATE USING (
    auth.uid() = user_id OR 
    auth.role() = 'service_role'
  );

CREATE POLICY "Allow deletes on job batches" ON public.job_batches
  FOR DELETE USING (
    auth.uid() = user_id OR 
    auth.role() = 'service_role'
  );

-- Verify the policies were created
SELECT policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'job_batches';

-- Test query (should return 0 if no job batches exist yet)
SELECT COUNT(*) FROM public.job_batches; 