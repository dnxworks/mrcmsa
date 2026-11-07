-- SalahRent (court booking only). Paste this whole file in Supabase > SQL Editor > Run.
-- If you ran the OLD version before, first run this line once:
-- drop table if exists feedback, bookings, rotation, facilities, rentals, rental_items, maintenance, courts, profiles cascade;

create extension if not exists btree_gist;

-- 1. TABLES ---------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text, email text,
  matric text, phone text, room text, club text,
  role text not null default 'student'
    check (role in ('student','mrc','principal','officer','fellow')),
  banned_until date              -- booking ban (3 days) for no-show / late cancel
);

create table facilities (
  id serial primary key,
  name text not null,
  place text,
  evening_rules boolean not null default false   -- true = weekend/rotation evening rules apply
);

create table rotation (          -- which sport uses the court on weekday evenings
  weekday int primary key check (weekday between 1 and 5),   -- 1 = Monday
  sport text not null
);

create table bookings (
  id serial primary key,
  user_id uuid not null references profiles,
  facility_id int not null references facilities,
  kind text not null default 'court' check (kind in ('court','program')),
  booking_date date not null,
  start_time time not null,
  end_time time not null check (end_time > start_time),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','cancelled','no_show','overridden')),
  sport text, purpose text,
  -- details of the person (saved on the booking so the slip never changes)
  full_name text, matric text, phone text, room text, club text,
  residency text check (residency in ('resident','non-resident')),
  participants int,
  -- program only
  program_name text, docs_link text,
  -- MRC decision
  admin_note text, approved_by_name text, reviewed_at timestamptz,
  created_at timestamptz default now(),
  -- two APPROVED bookings can never overlap on the same facility
  constraint no_double_approved exclude using gist (
    facility_id with =,
    tsrange(booking_date + start_time, booking_date + end_time) with &&
  ) where (status = 'approved')
);

create table feedback (
  id serial primary key,
  user_id uuid not null references profiles,
  full_name text,
  facility_id int references facilities,
  used_on date,
  rating int check (rating between 1 and 5),
  issue_type text,
  comment text,
  status text not null default 'none' check (status in ('none','open','in_progress','fixed')),
  created_at timestamptz default now()
);

-- 2. SMALL HELPERS ---------------------------------------------------------
create or replace function kl_now() returns timestamp language sql stable as
$$ select now() at time zone 'Asia/Kuala_Lumpur' $$;

-- Evening session = 5:00 pm to 7:30 pm. Change the times here if the MRC changes them
-- (also change EVENING_TEXT in js/config.js).
create or replace function overlaps_evening(s time, e time) returns boolean language sql immutable as
$$ select s < time '19:30' and e > time '17:00' $$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(my_role() <> 'student', false) $$;

-- 3. CREATE A PROFILE WHEN SOMEONE SIGNS UP -----------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), new.email);
  return new;
end $$;

drop trigger if exists on_signup on auth.users;
create trigger on_signup after insert on auth.users
for each row execute function handle_new_user();

-- 4. SECURITY (Row Level Security) ---------------------------------------------
alter table profiles   enable row level security;
alter table facilities enable row level security;
alter table rotation   enable row level security;
alter table bookings   enable row level security;
alter table feedback   enable row level security;

create policy "own profile, staff see all" on profiles for select to authenticated
  using (id = auth.uid() or is_staff());
create policy "update own profile" on profiles for update to authenticated
  using (id = auth.uid());
-- people may only change these columns (never role or ban)
revoke update on profiles from authenticated;
grant update (full_name, matric, phone, room, club) on profiles to authenticated;

create policy "see facilities" on facilities for select to authenticated using (true);
create policy "see rotation" on rotation for select to authenticated using (true);
create policy "MRC edits rotation" on rotation for all to authenticated
  using (my_role() = 'mrc') with check (my_role() = 'mrc');

-- Bookings: people see their own, staff see all. All changes go through the functions below.
create policy "own bookings, staff see all" on bookings for select to authenticated
  using (user_id = auth.uid() or is_staff());

create policy "own feedback, staff see all" on feedback for select to authenticated
  using (user_id = auth.uid() or is_staff());
create policy "send feedback" on feedback for insert to authenticated
  with check (user_id = auth.uid() and status in ('none','open'));
create policy "MRC updates feedback" on feedback for update to authenticated
  using (my_role() = 'mrc');

-- 5. BOOKING FUNCTIONS (the rules live here) -------------------------------------

-- 5a. Calendar: what is already booked (no personal details)
create or replace function calendar_slots(p_from date, p_to date)
returns table (facility_id int, booking_date date, start_time time, end_time time,
               status text, kind text, label text)
language sql stable security definer set search_path = public as $$
  select b.facility_id, b.booking_date, b.start_time, b.end_time, b.status, b.kind,
         case when b.kind = 'program' then coalesce(b.program_name, 'Program')
              else coalesce(b.sport, 'Booked') end
    from bookings b
   where auth.uid() is not null
     and b.status in ('pending','approved')
     and b.booking_date between p_from and p_to
   order by b.booking_date, b.start_time
$$;

-- 5b. Request a booking (court or program)
create or replace function request_booking(
  p_facility int, p_date date, p_start time, p_end time,
  p_sport text, p_purpose text,
  p_name text, p_matric text, p_phone text, p_room text, p_club text,
  p_residency text, p_participants int,
  p_kind text default 'court', p_program_name text default null, p_docs_link text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  prof profiles;
  fac facilities;
  dow int := extract(isodow from p_date);
  week_start date := date_trunc('week', p_date)::date;
  used_days int;
  rot text;
  new_id int;
begin
  if uid is null then raise exception 'Please log in first.'; end if;
  select * into prof from profiles where id = uid;
  select * into fac from facilities where id = p_facility;
  if fac.id is null then raise exception 'Facility not found.'; end if;
  if p_kind not in ('court','program') then raise exception 'Wrong booking type.'; end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_matric),'') = '' or coalesce(trim(p_phone),'') = ''
    then raise exception 'Name, matric number and phone number are required.'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time.'; end if;
  if (p_date + p_start) < kl_now() then raise exception 'You cannot book a time that has passed.'; end if;

  -- Rule 2: booking ban
  if prof.banned_until is not null and kl_now()::date < prof.banned_until then
    raise exception 'You cannot book until % because of a no-show, late arrival or late cancellation.',
      to_char(prof.banned_until, 'DD Mon YYYY');
  end if;

  if p_kind = 'court' then
    -- the time must be free (nobody pending or approved)
    if exists (select 1 from bookings b
                where b.facility_id = p_facility and b.booking_date = p_date
                  and b.status in ('pending','approved')
                  and b.start_time < p_end and b.end_time > p_start) then
      raise exception 'That time is already booked or waiting for approval. Please choose another time.';
    end if;

    -- Rule 1: maximum 3 days per week (per person or per club)
    select count(distinct b.booking_date) into used_days from bookings b
     where b.kind = 'court' and b.status in ('pending','approved')
       and b.booking_date >= week_start and b.booking_date < week_start + 7
       and b.booking_date <> p_date
       and (b.user_id = uid
            or (coalesce(trim(p_club),'') <> '' and lower(trim(b.club)) = lower(trim(p_club))));
    if used_days >= 3 then
      raise exception 'Limit reached: maximum 3 booking days per week. Please let other users have a turn.';
    end if;

    -- Rules 3 and 4: evening sessions (only for facilities with evening rules, e.g. MPC)
    if fac.evening_rules and overlaps_evening(p_start, p_end) then
      if dow >= 6 then
        raise exception 'Weekend evening sessions are only for University Bodies programs. Please use the Program tab.';
      end if;
      select sport into rot from rotation where weekday = dow;
      if rot is not null and p_sport is distinct from rot then
        raise exception 'Weekday evening sessions rotate between sports. % evening is for %. Please pick that sport or another time.',
          trim(to_char(p_date, 'Day')), rot;
      end if;
    end if;
  else
    if coalesce(trim(p_program_name),'') = '' or coalesce(trim(p_docs_link),'') = '' then
      raise exception 'Program name and the link to your documents are required.';
    end if;
    if exists (select 1 from bookings b
                where b.facility_id = p_facility and b.booking_date = p_date
                  and b.kind = 'program' and b.status = 'approved'
                  and b.start_time < p_end and b.end_time > p_start) then
      raise exception 'Another approved program already uses this time.';
    end if;
  end if;

  insert into bookings (user_id, facility_id, kind, booking_date, start_time, end_time,
                        sport, purpose, full_name, matric, phone, room, club,
                        residency, participants, program_name, docs_link)
  values (uid, p_facility, p_kind, p_date, p_start, p_end,
          p_sport, p_purpose, p_name, p_matric, p_phone, p_room, p_club,
          p_residency, p_participants, p_program_name, p_docs_link)
  returning id into new_id;

  -- remember the details for next time
  update profiles set full_name = p_name, matric = p_matric, phone = p_phone,
                      room = p_room, club = p_club where id = uid;
  return new_id;
end $$;

-- 5c. MRC approves or rejects. Program requests can override other bookings.
create or replace function review_booking(
  p_id int, p_decision text, p_note text default null, p_override boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare b bookings; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.role is distinct from 'mrc' then raise exception 'Only the MRC can approve or reject bookings.'; end if;
  select * into b from bookings where id = p_id for update;
  if b.id is null then raise exception 'Booking not found.'; end if;
  if b.status <> 'pending' then raise exception 'This booking was already reviewed.'; end if;

  if p_decision = 'rejected' then
    update bookings set status = 'rejected', admin_note = p_note,
           approved_by_name = me.full_name, reviewed_at = now() where id = p_id;
    return;
  elsif p_decision <> 'approved' then
    raise exception 'Wrong decision.';
  end if;

  if exists (select 1 from bookings o where o.id <> b.id and o.facility_id = b.facility_id
              and o.booking_date = b.booking_date and o.status = 'approved' and o.kind = 'program'
              and o.start_time < b.end_time and o.end_time > b.start_time) then
    raise exception 'Another approved program already uses this time.';
  end if;

  if exists (select 1 from bookings o where o.id <> b.id and o.facility_id = b.facility_id
              and o.booking_date = b.booking_date and o.status = 'approved'
              and o.start_time < b.end_time and o.end_time > b.start_time)
     and not (p_override and b.kind = 'program') then
    raise exception 'This time overlaps an approved booking. Reject it, or use "Approve + override" for a program.';
  end if;

  if p_override and b.kind = 'program' then
    update bookings o set status = 'overridden', reviewed_at = now(),
           admin_note = 'Cancelled by MRC for program: ' || coalesce(b.program_name, 'official program')
     where o.id <> b.id and o.facility_id = b.facility_id and o.booking_date = b.booking_date
       and o.kind = 'court' and o.status in ('pending','approved')
       and o.start_time < b.end_time and o.end_time > b.start_time;
  end if;

  -- anyone else still waiting for the same time is rejected
  update bookings o set status = 'rejected', reviewed_at = now(),
         admin_note = 'This time was given to another booking.'
   where o.id <> b.id and o.facility_id = b.facility_id and o.booking_date = b.booking_date
     and o.status = 'pending' and o.start_time < b.end_time and o.end_time > b.start_time;

  update bookings set status = 'approved', admin_note = p_note,
         approved_by_name = me.full_name, reviewed_at = now() where id = p_id;
end $$;

-- 5d. MRC reserves a court or hall for a program straight away (override)
create or replace function admin_program_override(
  p_facility int, p_date date, p_start time, p_end time,
  p_program_name text, p_club text, p_note text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare me profiles; bumped int;
begin
  select * into me from profiles where id = auth.uid();
  if me.role is distinct from 'mrc' then raise exception 'Only the MRC can override bookings.'; end if;
  if p_end <= p_start then raise exception 'End time must be after start time.'; end if;
  if exists (select 1 from bookings o where o.facility_id = p_facility and o.booking_date = p_date
              and o.kind = 'program' and o.status = 'approved'
              and o.start_time < p_end and o.end_time > p_start) then
    raise exception 'Another approved program already uses this time.';
  end if;

  update bookings o set status = 'overridden', reviewed_at = now(),
         admin_note = 'Cancelled by MRC for program: ' || p_program_name
   where o.facility_id = p_facility and o.booking_date = p_date and o.kind = 'court'
     and o.status in ('pending','approved') and o.start_time < p_end and o.end_time > p_start;
  get diagnostics bumped = row_count;

  insert into bookings (user_id, facility_id, kind, booking_date, start_time, end_time, status,
                        full_name, club, program_name, purpose, admin_note, approved_by_name, reviewed_at)
  values (auth.uid(), p_facility, 'program', p_date, p_start, p_end, 'approved',
          me.full_name, p_club, p_program_name, 'Reserved by MRC', p_note, me.full_name, now());
  return bumped;
end $$;

-- 5e. Cancel a booking. Cancelling an approved booking less than 3 hours before = 3-day ban.
create or replace function cancel_booking(p_id int) returns text
language plpgsql security definer set search_path = public as $$
declare b bookings; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  select * into b from bookings where id = p_id for update;
  if b.id is null then raise exception 'Booking not found.'; end if;
  if b.user_id is distinct from auth.uid() and me.role is distinct from 'mrc' then
    raise exception 'You cannot cancel this booking.';
  end if;
  if b.status not in ('pending','approved') then raise exception 'This booking cannot be cancelled.'; end if;

  update bookings set status = 'cancelled' where id = p_id;

  if b.user_id = auth.uid() and b.status = 'approved'
     and (b.booking_date + b.start_time) - kl_now() < interval '3 hours' then
    update profiles set banned_until = kl_now()::date + 3 where id = b.user_id;
    return 'late';
  end if;
  return 'ok';
end $$;

-- 5f. MRC marks a no-show or a late arrival (more than 15 minutes) = 3-day ban
create or replace function mark_no_show(p_id int) returns void
language plpgsql security definer set search_path = public as $$
declare b bookings; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.role is distinct from 'mrc' then raise exception 'Only the MRC can do this.'; end if;
  select * into b from bookings where id = p_id for update;
  if b.id is null or b.status <> 'approved' then raise exception 'Only approved bookings can be marked.'; end if;
  if (b.booking_date + b.start_time) > kl_now() then raise exception 'You can only do this after the booking start time.'; end if;
  update bookings set status = 'no_show' where id = p_id;
  update profiles set banned_until = kl_now()::date + 3 where id = b.user_id;
end $$;

-- 6. LIVE UPDATES (so the status changes on the student's screen by itself) ----------
alter publication supabase_realtime add table bookings;
alter publication supabase_realtime add table feedback;

-- 7. STARTER DATA --------------------------------------------------------------
insert into facilities (name, place, evening_rules) values
  ('MPH Salahuddin', 'Indoor multi-purpose hall', false),
  ('MPC Salahuddin', 'Outdoor multi-purpose court', true);

-- Placeholder rotation. The MRC can change it in the app (Rules tab).
insert into rotation (weekday, sport) values
  (1,'Volleyball'), (2,'Netball'), (3,'Futsal'), (4,'Volleyball'), (5,'Netball');

-- 8. MAKE AN MRC ADMIN ------------------------------------------------------------
-- a) Supabase > Authentication > Users > Add user (email + password)
-- b) Then run this (use that email):
-- update profiles set role = 'mrc' where email = 'mrc@example.com';
-- Use 'principal', 'officer' or 'fellow' for read-only staff.
