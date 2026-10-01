# Guestlist — notes for Claude

## Forms must survive a refresh

Nothing a person types should be lost to a refresh, a crash, a closed tab or a
phone dropping the page. On this site that is handled once, globally:

- `components/FormDrafts.tsx` is mounted in `app/layout.tsx`. It saves every
  `<form>` (and any element marked `data-draft="name"`) to localStorage as the
  person types, and puts it back when the page returns, with a small
  "We kept what you'd typed here · Start over" note.
- New forms are covered automatically — **use a real `<form>`**. An editor
  built without one (buttons with onClick, no form tag) must carry
  `data-draft="some-name"` on its outer element, or it won't be saved.
- Give fields a stable `id` or `name`; that is how a saved value finds its
  field again. Position is only the fallback.
- Prefer functional state updates (`setV((x) => ({ ...x, ...patch }))`).
- Not saved: passwords, card/OTP-like fields, file pickers, hidden fields,
  search forms (`role="search"` or `method="get"`). Opt anything else out
  with `data-no-draft` on the field or the form.
- A draft is cleared when its form is submitted, after 7 days, and on sign out.
- File uploads can't be kept as files — upload straight away and keep the
  returned URL in a normal field (see `components/market/ImageField.tsx`),
  and the URL survives like any other text.
