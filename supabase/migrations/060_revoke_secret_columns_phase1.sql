-- ============================================================
-- 060_revoke_secret_columns_phase1.sql — M-04, fase 1
--
-- Quita al rol `authenticated` la lectura de las dos columnas que
-- solo el servidor necesita:
--
--   api_keys.key_hash          SHA-256 de la clave; lo lee el auth path
--                              de la API pública con service role.
--   webhook_endpoints.secret   Clave de firma AES-256-GCM; la lee el
--                              entregador con service role.
--
-- Por qué REVOKE a nivel de tabla + GRANT por columna:
--   Supabase concede `GRANT ALL ON ALL TABLES` a `authenticated`, y en
--   PostgreSQL un `REVOKE SELECT (columna)` NO surte efecto mientras
--   exista el privilegio SELECT a nivel de tabla. Hay que revocar el
--   SELECT de tabla y volver a conceder la lista explícita de columnas.
--
-- Consecuencia deliberada:
--   `select=*` sobre estas dos tablas deja de funcionar para un JWT de
--   usuario (SQLSTATE 42501). Ningún call site lo usa: la API selecciona
--   `SAFE_COLUMNS` / `WEBHOOK_PUBLIC_COLUMNS` y la UI no lee estas tablas
--   directamente. INSERT/UPDATE/DELETE siguen a nivel de tabla, así que
--   crear/revocar claves y gestionar endpoints no cambia.
--
-- Fuera de alcance (fases 2 y 3 del plan):
--   `ai_configs.api_key` y `whatsapp_config.access_token` / `verify_token`
--   necesitan primero mover sus lecturas a un cliente service-role
--   scoped por `account_id`; revocarlas ahora rompería envío, broadcast,
--   plantillas y media.
--
-- Idempotente: REVOKE/GRANT se pueden re-ejecutar sin efectos extra.
-- ============================================================

REVOKE SELECT ON public.api_keys FROM anon, authenticated;
GRANT SELECT (
  id,
  account_id,
  created_by,
  name,
  key_prefix,
  scopes,
  last_used_at,
  expires_at,
  revoked_at,
  created_at
) ON public.api_keys TO authenticated;

REVOKE SELECT ON public.webhook_endpoints FROM anon, authenticated;
GRANT SELECT (
  id,
  account_id,
  created_by,
  url,
  events,
  is_active,
  last_delivery_at,
  failure_count,
  created_at
) ON public.webhook_endpoints TO authenticated;

-- PostgREST cachea privilegios de columna; forzar recarga del esquema.
NOTIFY pgrst, 'reload schema';
