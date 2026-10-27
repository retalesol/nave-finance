-- MoonPay card payments can take days. Keep the invoice payable until the
-- transfer lands instead of letting the due date close the window.

CREATE OR REPLACE FUNCTION public.pay_extend_invoice_for_moonpay(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  inv public.pay_invoices%ROWTYPE;
  hold_until date;
BEGIN
  IF coalesce(auth.role(), '') IS DISTINCT FROM 'service_role'
     AND coalesce(current_setting('request.jwt.claims', true)::json->>'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-fA-F]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_token');
  END IF;
  SELECT * INTO inv FROM public.pay_invoices WHERE public_token = lower(p_token) FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_payable');
  END IF;
  IF public.pay_paid_cents(inv.id) >= inv.total_cents THEN
    RETURN jsonb_build_object('ok', true, 'status', 'paid', 'due_date', inv.due_date);
  END IF;
  hold_until := greatest(inv.issue_date, (now() AT TIME ZONE 'UTC')::date + 30);
  IF inv.due_date < hold_until THEN
    UPDATE public.pay_invoices
    SET due_date = hold_until, updated_at = now()
    WHERE id = inv.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'due_date', greatest(inv.due_date, hold_until));
END;
$fn$;

REVOKE ALL ON FUNCTION public.pay_extend_invoice_for_moonpay(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_extend_invoice_for_moonpay(text) TO service_role;

COMMENT ON FUNCTION public.pay_extend_invoice_for_moonpay(text) IS
  'Service role only. Extends a sent invoice due date by 30 days so a MoonPay payment can finish.';
