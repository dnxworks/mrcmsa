# SalahRent: MPH / MPC Court Booking (Mahallah Salahuddin)

Plain HTML, CSS and JavaScript. Free database and login by Supabase. Hosted free on GitHub Pages.

## Folder

```
index.html        the page
css/style.css     the look
js/config.js      your keys, document list, contacts (EDIT THIS)
js/app.js         all the logic (commented)
supabase/schema.sql   database + booking rules
docs/booking-rules.pdf  rules file students can open
assets/logo.jpeg
```

## Setup (one time)

1. **Supabase**: create a project at supabase.com. Open SQL Editor, paste all of `supabase/schema.sql`, click Run.

Supabase Pass = SalahuddinDiHati
2. **Keys**: Project Settings > API. Copy the Project URL and the anon public key into `js/config.js`.
3. **GitHub**: create a new public repository. Upload all the files (drag and drop works). Then Settings > Pages > Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`, Save.
   Your link will be `https://YOUR-NAME.github.io/REPO-NAME/`.
4. **Login redirect**: Supabase > Authentication > URL Configuration. Set Site URL to your GitHub Pages link. Add the same link (with `/` at the end) under Redirect URLs. For testing on your laptop also add `http://127.0.0.1:5500/`.
5. **Google login**: Supabase > Authentication > Providers > Google. Turn it on and paste the Client ID and Secret from Google Cloud Console (APIs and Services > Credentials > OAuth client ID, type Web application). In Google, add this Authorized redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
6. **MRC admin**: Supabase > Authentication > Users > Add user (email and password). Then in SQL Editor run:
   `update profiles set role = 'mrc' where email = 'your-email@example.com';`
   (Use `principal`, `officer` or `fellow` for read-only staff.)
7. **Documents for programs**: put your files in the `docs` folder and list them in `PROGRAM_DOCUMENTS` inside `js/config.js`.

After you change a file, upload it again to GitHub. The site updates in about a minute.

## How the rules work

| Rule | What the system does |
|---|---|
| Max 3 days per week | Blocks the 4th day in the same week (per person or same club name) |
| No-show / late / late cancel | MRC taps "No-show / late". Cancelling an approved booking under 3 hours before start also bans. Ban = 3 days |
| Weekend evening | Only program requests are allowed (MPC) |
| Weekday evening | Student must pick the sport of that day (MPC). MRC edits the rotation in the Rules tab |
| Overlap | A time that is pending or approved cannot be booked again |
| Override | MRC reserves a program and student bookings at that time are cancelled |

Evening time is 5:00 pm to 7:30 pm. To change it, edit `overlaps_evening` in `schema.sql` and `EVENING_TEXT` in `config.js`.
