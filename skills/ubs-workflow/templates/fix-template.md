# UBS Finding Fix Template

Copy this template for each finding you need to fix.

---

## Finding #[N]: [Title]

**Severity:** Critical / High / Medium / Low

**Location:** `[file:line]`

**Category:** [Null safety / Security / Async / Resource leak / Error handling / etc.]

### Code (Before)

```[language]
// Paste the problematic code here
```

### Analysis

**Root Cause:**
[Explain why this bug exists and what the actual risk is]

**Real Bug or False Positive:**

- [ ] Real bug - needs fix
- [ ] False positive - needs suppression comment

**If False Positive, Why:**
[Explain why the code is actually safe, e.g., "validated by caller", "dead code path", "framework guarantee"]

### Fix (After)

```[language]
// Paste the fixed code here
```

### Test Case

```[language]
// Paste the test that verifies the fix
```

### Effort Estimate

- [ ] Trivial (< 5 min)
- [ ] Small (5-30 min)
- [ ] Medium (30 min - 2 hours)
- [ ] Large (> 2 hours)

### Commit Message

```
fix: [brief description]

Addresses UBS finding #[N] ([category])
- [What was changed]
- [Why it fixes the issue]
```

---

## Checklist

Before marking this finding as resolved:

- [ ] Fix applied
- [ ] Test added and passing
- [ ] UBS re-scan shows no regression
- [ ] Commit created with proper message
- [ ] If false positive: suppression comment includes justification
