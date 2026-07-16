# Brainstorm — Deferred Ideas

A holding area for ideas that are worth building eventually but not prioritised right now.

---

## Auto-fill member name on mobile lookup

**Context:** When admin adds a member to a group, they enter mobile number + name manually.

**Idea:** Once the admin types a valid mobile number, hit a lightweight backend lookup. If the number belongs to an existing user, auto-fill the name field and dim it (making clear it came from the system).

**Why it's worth doing:**
- The backend `addMember` service already looks up by mobile and silently ignores the typed name when the user exists — auto-fill makes this transparent and prevents the admin from thinking a wrong name was saved.
- Faster onboarding when adding repeat members across groups.

**Implementation sketch:**
- Backend: `GET /users/lookup?mobile=+91xxxxxxxxxx` (admin-only) → `{ name, user_id }` or 404
- Frontend: on blur of the mobile field (valid 10-digit number), fire the lookup, auto-fill + lock the name input with a "found in system" label

**Skipped because:** Not a priority right now; UX works without it.

---

## Add member directly from phone contacts

**Context:** When admin adds a member, they manually type mobile number + name.

**Idea:** A "Pick from Contacts" button that opens the OS native contact picker so the admin can select a contact and have name + mobile auto-fill in the form.

**Platform reality — Contact Picker API support:**
- Chrome on Android ✅
- Safari on iOS 14.5+ ✅
- Desktop Chrome ❌
- Desktop Safari ❌
- Firefox ❌

Since the app is mobile-first (max-w-md), this covers the primary use case. On desktop the button is simply hidden.

**Implementation sketch:**
```js
const [contact] = await navigator.contacts.select(['name', 'tel'], { multiple: false })
// prefill name = contact.name[0], mobile = normalise(contact.tel[0])
```
Mobile numbers from contacts come in inconsistent formats (`9812345678`, `+91 98123 45678`, `098-123-45678`) — needs E.164 normalisation before submission (the form already does this).

**Skipped because:** Not a priority right now.
