/*
  # DAO logos storage bucket

  Creates a public storage bucket for DAO/treasury logo images uploaded during
  the creation flow. Images are cropped to a square client-side before upload.

  1. Bucket
     - `dao-logos` — public read, 2 MB limit, common image mime types
  2. Policies
     - Public read of objects
     - Authenticated/anon upload (RLS keeps this scoped to the bucket; logos are
       non-sensitive public assets keyed by DAO address)
*/

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dao-logos',
  'dao-logos',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'dao-logos public read'
  ) then
    create policy "dao-logos public read"
      on storage.objects for select
      using (bucket_id = 'dao-logos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'dao-logos upload'
  ) then
    create policy "dao-logos upload"
      on storage.objects for insert
      with check (bucket_id = 'dao-logos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'dao-logos update'
  ) then
    create policy "dao-logos update"
      on storage.objects for update
      using (bucket_id = 'dao-logos');
  end if;
end $$;
