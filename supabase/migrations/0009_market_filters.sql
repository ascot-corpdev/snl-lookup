-- SNL lookup: "Narrow it down" on the Market view. Lets one question to the market index name several states and
-- several types of insurance at once. Run once in the Supabase SQL editor (or `supabase db push`), after
-- 0006_market_index.sql. Safe to run again. If 0006 is ever run again, run this file again after it.
--
-- It replaces the two database functions that answer a question (snl_index_match, snl_index_query) with versions
-- that also take, in p:
--   scope  a list of {state, from, to}: the states asked for, each over the part of the period its own sweep covers
--          (the snl-index function works these out from snl_index_states, so a state is never answered over dates
--          its sweep didn't cover);
--   types  a list of types of insurance: a filing matches when its type or sub-type contains any of them, in any
--          letter case (as the one typeOfInsurance always has).
-- A question without scope or types is answered exactly as 0006 answers it. Every answer now says filters: 2, so the
-- function knows these lists were used; before this migration they would be ignored, and the function refuses such
-- a question instead of answering it wider than asked. No table, policy or grant changes: logins still only read
-- the tables, and only the service role runs these functions.

create or replace function public.snl_index_match(p jsonb)
returns setof public.snl_index_filings
language sql stable
as $$
  select f.* from public.snl_index_filings f
  where (case when jsonb_typeof(p->'scope') = 'array' and jsonb_array_length(p->'scope') > 0 then
           exists (
             select 1 from jsonb_array_elements(p->'scope') as s(e)
             where f.state = s.e->>'state'
               and (nullif(s.e->>'from', '') is null or f.publish_date >= (s.e->>'from')::date)
               and (nullif(s.e->>'to', '') is null or f.publish_date <= (s.e->>'to')::date))
         else
           f.state = p->>'state'
           and (nullif(p->>'from', '') is null or f.publish_date >= (p->>'from')::date)
           and (nullif(p->>'to', '') is null or f.publish_date <= (p->>'to')::date)
         end)
    and (case when jsonb_typeof(p->'types') = 'array' and jsonb_array_length(p->'types') > 0 then
           exists (
             select 1 from jsonb_array_elements_text(p->'types') as t(name)
             where strpos(lower(coalesce(f.type_of_insurance, '') || ' / ' || coalesce(f.sub_type_of_insurance, '')), lower(t.name)) > 0)
         else
           nullif(p->>'typeOfInsurance', '') is null
           or strpos(lower(coalesce(f.type_of_insurance, '') || ' / ' || coalesce(f.sub_type_of_insurance, '')), lower(p->>'typeOfInsurance')) > 0
         end)
    and (nullif(p->>'filingType', '') is null or strpos(lower(coalesce(f.filing_type, '')), lower(p->>'filingType')) > 0)
    and (nullif(p->>'status', '') is null or strpos(lower(coalesce(f.filing_status, '')), lower(p->>'status')) > 0)
    and (nullif(p->>'rateAbove', '') is null or f.rate_impact > (p->>'rateAbove')::numeric)
    and (nullif(p->>'rateBelow', '') is null or f.rate_impact < (p->>'rateBelow')::numeric)
    and not exists (
      select 1 from jsonb_array_elements_text(case when jsonb_typeof(p->'words') = 'array' then p->'words' else '[]'::jsonb end) as w(word)
      where strpos(lower(coalesce(f.description, '') || ' ' || f.company_names), lower(w.word)) = 0)
$$;

-- As 0006, with stateRows and stateDescribed counted over every state in scope, and filters: 2 in every answer.
create or replace function public.snl_index_query(p jsonb)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  v_group  text := coalesce(nullif(p->>'group', ''), 'rows');
  v_limit  integer := least(greatest(coalesce((p->>'limit')::integer, 50), 1), 500);
  v_offset integer := least(greatest(coalesce((p->>'offset')::integer, 0), 0), 100000);
  v_states text[];
  v_out    jsonb;
  v_more   jsonb;
begin
  if v_group not in ('rows', 'company', 'type', 'month') then
    raise exception 'unknown group %', v_group;
  end if;
  if jsonb_typeof(p->'scope') = 'array' and jsonb_array_length(p->'scope') > 0 then
    select array_agg(e->>'state') into v_states from jsonb_array_elements(p->'scope') as s(e);
  else
    v_states := array[p->>'state'];
  end if;
  select jsonb_build_object(
    'total', count(*),
    'withRate', count(*) filter (where m.rate_impact is not null),
    'rateFilings', count(*) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0))
  into v_out from public.snl_index_match(p) m;
  select jsonb_build_object('stateRows', count(*), 'stateDescribed', count(*) filter (where s.description is not null), 'filters', 2)
  into v_more from public.snl_index_filings s where s.state = any(v_states);
  v_out := v_out || v_more;

  if v_group = 'rows' then
    select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(x) - 'sweep_id' - 'seen_at' order by x.publish_date desc nulls last, x.filing_key collate "C"), '[]'::jsonb))
    into v_more
    from (select * from public.snl_index_match(p) m order by m.publish_date desc nulls last, m.filing_key collate "C" limit v_limit offset v_offset) x;
  elsif v_group = 'company' then
    with g as (
      select coalesce('c' || (c.e->>'c'), 'i' || (c.e->>'i'), 'n' || lower(c.e->>'n')) as k,
        max(c.e->>'n' collate "C") as name, max(c.e->>'c' collate "C") as company_id, max(c.e->>'i' collate "C") as institution_id,
        count(distinct m.state || '|' || m.filing_key) as filings,
        count(distinct m.state || '|' || m.filing_key) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0) as rate_filings,
        min(m.rate_impact) as rate_min, max(m.rate_impact) as rate_max, max(m.publish_date) as latest
      from public.snl_index_match(p) m, jsonb_array_elements(m.companies) as c(e)
      group by 1)
    select jsonb_build_object('groupTotal', (select count(*) from g), 'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'companyId', x.company_id, 'institutionId', x.institution_id, 'filings', x.filings,
        'rateFilings', x.rate_filings, 'rateMin', x.rate_min, 'rateMax', x.rate_max, 'latest', x.latest) order by x.filings desc, x.name collate "C", x.k collate "C")
      from (select * from g order by g.filings desc, g.name collate "C", g.k collate "C" limit v_limit offset v_offset) x), '[]'::jsonb))
    into v_more;
  else
    with g as (
      select case when v_group = 'type' then coalesce(m.type_of_insurance, 'n/d') else coalesce(to_char(m.publish_date, 'YYYY-MM'), 'n/d') end as name,
        count(*) as filings,
        count(*) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0) as rate_filings,
        min(m.rate_impact) as rate_min, max(m.rate_impact) as rate_max, max(m.publish_date) as latest
      from public.snl_index_match(p) m
      group by 1)
    select jsonb_build_object('groupTotal', (select count(*) from g), 'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'filings', x.filings, 'rateFilings', x.rate_filings, 'rateMin', x.rate_min,
        'rateMax', x.rate_max, 'latest', x.latest) order by x.o1, x.o2, x.name collate "C")
      from (select g.*, case when v_group = 'type' then -g.filings else 0 end as o1, case when g.name = 'n/d' then 1 else 0 end as o2
            from g order by o1, o2, g.name collate "C" limit v_limit offset v_offset) x), '[]'::jsonb))
    into v_more;
  end if;
  return v_out || v_more;
end $$;

-- ---------- grants: as 0006 (create or replace keeps them; restated so this file stands on its own) ----------
revoke all on function public.snl_index_match(jsonb), public.snl_index_query(jsonb) from public, anon, authenticated;
grant execute on function public.snl_index_match(jsonb), public.snl_index_query(jsonb) to service_role;
