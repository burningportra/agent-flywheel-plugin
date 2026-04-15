# Example: Rust Code Review with UBS

This example demonstrates the UBS workflow on a Rust project.

## Project Setup

```
my-rust-project/
├── Cargo.toml
├── src/
│   ├── main.rs
│   └── lib.rs
└── tests/
```

## Step 1: Initial Scan

```bash
cd my-rust-project
ubs --only=rust src/
```

**Sample Output:**

```
src/lib.rs:45 [HIGH] Potential null pointer dereference
  user.profile.unwrap().name
  └── Consider using `?` operator or explicit match

src/lib.rs:78 [MEDIUM] Resource leak: file handle not closed
  let file = File::open(path);
  └── Use `drop(file)` or let scope handle cleanup

src/main.rs:23 [LOW] TODO marker found
  // TODO: implement error handling
```

## Step 2: Triage

### Finding 1: Null pointer dereference (HIGH)

**Location:** `src/lib.rs:45`

**Code:**

```rust
fn get_user_name(user: Option<User>) -> String {
    user.profile.unwrap().name.clone()  // <- Panic if None!
}
```

**Analysis:**

- `unwrap()` will panic if `user.profile` is `None`
- This is a real bug - callers may pass users without profiles
- **Verdict: REAL BUG**

### Finding 2: Resource leak (MEDIUM)

**Location:** `src/lib.rs:78`

**Code:**

```rust
fn read_config(path: &str) -> Result<Config, Error> {
    let file = File::open(path)?;
    // file is dropped at end of scope
    let config = serde_json::from_reader(&file)?;
    Ok(config)
}
```

**Analysis:**

- File handle IS closed when `file` goes out of scope (Rust's RAII)
- UBS may not track scope-based cleanup perfectly
- **Verdict: FALSE POSITIVE**

### Finding 3: TODO marker (LOW)

**Location:** `src/main.rs:23`

**Verdict:** Discuss in PR, not blocking.

## Step 3: Fix Plan

### Fix for Finding 1

**Root Cause:** Unchecked `unwrap()` on optional profile.

**Fix:**

```rust
fn get_user_name(user: Option<User>) -> Option<String> {
    user.and_then(|u| u.profile)
        .map(|p| p.name.clone())
}
```

**Test Case:**

```rust
#[test]
fn test_get_user_name_none() {
    assert_eq!(get_user_name(None), None);
}

#[test]
fn test_get_user_name_no_profile() {
    let user = User { profile: None, ..Default::default() };
    assert_eq!(get_user_name(Some(user)), None);
}

#[test]
fn test_get_user_name_with_profile() {
    let user = User {
        profile: Some(Profile { name: "Alice".into() }),
        ..Default::default()
    };
    assert_eq!(get_user_name(Some(user)), Some("Alice".into()));
}
```

**Effort:** Small (change signature + add tests)

## Step 4: Apply Fix

```bash
# Edit src/lib.rs with the fix

# Run tests
cargo test

# Re-scan
ubs --staged

# Commit
git add src/lib.rs tests/
git commit -m "fix: handle None profile in get_user_name

Addresses UBS finding #1 (null safety)
- Changed return type to Option<String>
- Added tests for None cases"
```

## Step 5: Suppress False Positive

For Finding 2, add suppression with justification:

```rust
fn read_config(path: &str) -> Result<Config, Error> {
    let file = File::open(path)?;  // ubs:ignore - RAII ensures cleanup at scope end
    let config = serde_json::from_reader(&file)?;
    Ok(config)
}
```

## Final Verification

```bash
ubs --staged
# Exit code: 0
```

The review is complete. All critical issues are fixed, false positives are documented.
