# Example: TypeScript Code Review with UBS

This example demonstrates the UBS workflow on a TypeScript/Next.js project.

## Project Setup

```
my-nextjs-app/
├── package.json
├── tsconfig.json
├── src/
│   ├── app/
│   ├── components/
│   └── lib/
└── tests/
```

## Step 1: Initial Scan

```bash
cd my-nextjs-app
ubs --only=ts,tsx src/
```

**Sample Output:**

```
src/lib/api.ts:23 [CRITICAL] Missing await on async function
  fetchUserData(userId);
  └── Promise result is discarded

src/components/UserProfile.tsx:45 [HIGH] Potential null dereference
  user.profile.avatar
  └── user.profile may be undefined

src/lib/db.ts:67 [HIGH] Error swallowed silently
  } catch (e) {}
  └── Error is caught but not handled or logged

src/app/api/users/route.ts:12 [MEDIUM] SQL injection risk
  `SELECT * FROM users WHERE id = ${userId}`
  └── Use parameterized queries
```

## Step 2: Triage

### Finding 1: Missing await (CRITICAL)

**Location:** `src/lib/api.ts:23`

**Code:**

```typescript
async function refreshUserSession(userId: string) {
  fetchUserData(userId); // <- Missing await!
  console.log("Session refreshed");
}
```

**Analysis:**

- `fetchUserData` is async but not awaited
- The function returns before fetch completes
- Race condition: "Session refreshed" logs before data arrives
- **Verdict: REAL BUG**

### Finding 2: Null dereference (HIGH)

**Location:** `src/components/UserProfile.tsx:45`

**Code:**

```typescript
function UserProfile({ user }: { user: User }) {
  return (
    <img src={user.profile.avatar} alt="Avatar" />
  );
}
```

**Analysis:**

- `user.profile` could be undefined based on the User type
- Will throw at runtime if profile is missing
- **Verdict: REAL BUG**

### Finding 3: Error swallowed (HIGH)

**Location:** `src/lib/db.ts:67`

**Code:**

```typescript
async function saveUser(user: User) {
  try {
    await db.users.insert(user);
  } catch (e) {} // <- Silent failure!
}
```

**Analysis:**

- Database errors are caught and ignored
- Caller has no idea if save succeeded
- **Verdict: REAL BUG**

### Finding 4: SQL injection (MEDIUM)

**Location:** `src/app/api/users/route.ts:12`

**Code:**

```typescript
const result = await db.execute(`SELECT * FROM users WHERE id = ${userId}`);
```

**Analysis:**

- Direct string interpolation in SQL query
- If `userId` comes from user input, this is exploitable
- **Verdict: REAL BUG (if userId is untrusted)**

## Step 3: Fix Plan

### Fix for Finding 1 (Missing await)

**Root Cause:** Forgot to await async function.

**Before:**

```typescript
async function refreshUserSession(userId: string) {
  fetchUserData(userId);
  console.log("Session refreshed");
}
```

**After:**

```typescript
async function refreshUserSession(userId: string) {
  await fetchUserData(userId);
  console.log("Session refreshed");
}
```

**Test Case:**

```typescript
it("waits for data before logging", async () => {
  const fetchSpy = vi.spyOn(api, "fetchUserData").mockResolvedValue({ id: "1", name: "Test" });
  const logSpy = vi.spyOn(console, "log");

  await refreshUserSession("1");

  expect(fetchSpy).toHaveBeenCalledBefore(logSpy);
});
```

**Effort:** Trivial

### Fix for Finding 2 (Null dereference)

**Root Cause:** Not handling optional profile.

**Before:**

```typescript
<img src={user.profile.avatar} alt="Avatar" />
```

**After:**

```typescript
<img
  src={user.profile?.avatar ?? '/default-avatar.png'}
  alt="Avatar"
/>
```

**Test Case:**

```typescript
it('renders default avatar when profile is missing', () => {
  const user = { id: '1', name: 'Test' };  // no profile
  render(<UserProfile user={user} />);
  expect(screen.getByRole('img')).toHaveAttribute(
    'src',
    '/default-avatar.png'
  );
});
```

**Effort:** Trivial

### Fix for Finding 3 (Swallowed error)

**Root Cause:** Empty catch block.

**Before:**

```typescript
try {
  await db.users.insert(user);
} catch (e) {}
```

**After:**

```typescript
try {
  await db.users.insert(user);
} catch (e) {
  console.error("Failed to save user:", e);
  throw new DatabaseError("User save failed", { cause: e });
}
```

**Test Case:**

```typescript
it("propagates database errors", async () => {
  vi.spyOn(db.users, "insert").mockRejectedValue(new Error("DB down"));

  await expect(saveUser(testUser)).rejects.toThrow(DatabaseError);
});
```

**Effort:** Small

### Fix for Finding 4 (SQL injection)

**Root Cause:** String interpolation in SQL.

**Before:**

```typescript
`SELECT * FROM users WHERE id = ${userId}`;
```

**After:**

```typescript
db.execute("SELECT * FROM users WHERE id = $1", [userId]);
```

**Test Case:**

```typescript
it("escapes malicious input", async () => {
  const maliciousId = "'; DROP TABLE users; --";
  await getUser(maliciousId);

  // Verify table still exists
  const count = await db.execute("SELECT COUNT(*) FROM users");
  expect(count).toBeDefined();
});
```

**Effort:** Small

## Step 4: Apply Fixes

```bash
# Fix each issue one at a time

# Fix 1: Add await
# Edit src/lib/api.ts

# Run tests
npm test -- src/lib/api.test.ts

# Re-scan
ubs --staged
# Should show 3 remaining issues

# Commit
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "fix: await fetchUserData in refreshUserSession

Addresses UBS finding #1 (missing await)
- Added await to prevent race condition
- Added test verifying execution order"

# Repeat for each fix...
```

## Final Verification

```bash
ubs --staged
# Exit code: 0

ubs src/ --skip=11,12  # Skip TODOs and debug markers
# Exit code: 0
```

## Setting Up Pre-commit Hook

Add to `.husky/pre-commit`:

```bash
#!/bin/sh
ubs --staged --fail-on-warning
```

Now UBS runs automatically before every commit.
