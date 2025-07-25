-- Check RLS status and policies on job_batches table
-- Run this on BOTH dev and staging to compare

-- 1. Check if job_batches table exists and RLS status
SELECT 
  schemaname,
  tablename,
  rowsecurity as "RLS_Enabled"
FROM pg_tables 
WHERE tablename = 'job_batches';

-- 2. Check what RLS policies exist
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd as "Operation",
  qual as "Using_Condition",
  with_check as "With_Check_Condition"
FROM pg_policies 
WHERE tablename = 'job_batches';

-- 3. Check if table exists at all
SELECT EXISTS (
  SELECT 1 
  FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_name = 'job_batches'
) as "Table_Exists";

-- 4. Alternative way to check RLS status using pg_class
SELECT 
  n.nspname as "Schema",
  c.relname as "Table", 
  c.relrowsecurity as "RLS_Enabled",
  c.relforcerowsecurity as "RLS_Forced"
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'job_batches' AND n.nspname = 'public';

-- 5. Try to access table (this will show if RLS blocks access)
SELECT 
  COUNT(*) as "Record_Count",
  'Accessible with current key' as "Status"
FROM public.job_batches; 