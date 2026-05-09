---
name: security-checklist
description: Security review checklist covering the most common code-level vulnerabilities
triggers: [security, vulnerability, injection, XSS, SQL injection, auth, secrets, sanitize, safe]
---

## Security Checklist

**Input validation**
- Validate all user-supplied input at the entry point — before it's used anywhere
- Reject unexpected shapes early; don't rely on downstream code to handle bad input
- Never trust client-supplied IDs, roles, or permissions without server-side verification

**SQL / NoSQL injection**
- Use parameterized queries or ORM methods — never concatenate user input into SQL strings
- `WHERE id = '${userId}'` is always wrong; `WHERE id = ?` with a bound parameter is right
- Applies to any query language: Mongo filters, Elasticsearch queries, LDAP, etc.

**Command injection**
- Never pass user input to shell commands (`exec`, `spawn` with `shell: true`, `eval`)
- If shell execution is required, use an allowlist of permitted values, never free-form input

**Output encoding (XSS)**
- Escape HTML output when rendering user content in a browser context
- `innerHTML = userValue` is dangerous; use `textContent` or a sanitizer library
- Set `Content-Security-Policy` headers; don't rely on escaping alone

**Authentication and authorization**
- Check auth on every request that accesses sensitive data — not just the entry route
- Authorization must be server-side; client-side role checks are UI conveniences, not security
- Use short-lived tokens; implement refresh token rotation; revoke on logout

**Secrets management**
- No API keys, passwords, or tokens in source code or committed config files
- Use environment variables or a secrets manager; verify `.env` files are in `.gitignore`
- Rotate any secret that was ever accidentally exposed — assume it's compromised

**Sensitive data handling**
- Don't log passwords, tokens, PII, or full credit card numbers
- Transmit sensitive data only over TLS; store passwords hashed (bcrypt/argon2, not MD5/SHA1)
- Apply least-privilege: components should access only the data they need
