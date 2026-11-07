// 1. Supabase > Project Settings > API. Paste your Project URL and anon public key.
//    (The anon key is safe to put on GitHub. NEVER paste the service_role key.)
const SUPABASE_URL = 'https://vwjyxsecjqgtnhiyzfmw.supabase.co';
const SUPABASE_ANON_KEY = 'vwjyxsecjqgtnhiyzfmw';

// 2. Evening session text shown to students (must match overlaps_evening() in schema.sql)
const EVENING_TEXT = '5:00 pm to 7:30 pm';

// 3. Documents needed to use Mahallah Office facilities for a program.
//    EDIT THIS LIST. Put each file in the "docs" folder and write its path in "file".
//    Leave file empty ('') if there is no file to download.
const PROGRAM_DOCUMENTS = [
  { name: 'Program paperwork (proposal)', note: 'Replace this with your real document name.', file: '' },
  { name: 'Mahallah Office facility request form', note: 'Replace this with your real form. Fill it in and sign it.', file: '' },
  { name: 'Approval letter from your club advisor', note: 'Replace this if your process is different.', file: '' },
];

// 4. Contacts for questions (MRC Sports & Recreation Bureau)
const CONTACTS = [
  { name: 'Br. Aiman', phone: '+60 13-469 4129', wa: '60134694129' },
  { name: 'Sr. Leera', phone: '+60 11-2133 1664', wa: '601121331664' },
];
