---
name: performance-profiling
description: Methodology for identifying and fixing real performance bottlenecks, not hypothetical ones
triggers: [performance, slow, latency, optimize, profiling, bottleneck, speed up, memory, CPU]
---

## Performance Profiling

**Rule zero: measure before you optimize**
Never optimize code you haven't measured. Intuition about bottlenecks is wrong more often than not. Profile first, then fix what the profile shows.

**Find the hot path**
Use a profiler (Node.js `--prof`, Chrome DevTools, `clinic.js`, `py-spy`, etc.) to find where time is actually spent. Look for the functions at the top of the flame graph.

**Common bottlenecks**

*Database / I/O*
- N+1 queries: fetching related data in a loop instead of a JOIN or batch fetch
- Missing index on a filtered or sorted column
- Fetching more columns than needed (`SELECT *` when you need 2 fields)
- Synchronous I/O blocking the event loop

*CPU*
- Repeated expensive computation inside a render/request loop — move it outside or memoize
- Regex compiled inside a loop — compile once, reuse
- Large JSON.parse/stringify on hot paths — consider streaming or caching

*Memory*
- Unbounded caches growing forever — add a max size or TTL
- Event listeners not removed — memory leaks in long-running processes
- Large object graphs kept alive by closures — check what closures capture

**Memoization pattern**
Cache the result of a pure function keyed by its inputs. Only safe when: (1) inputs are the full determinant of output, (2) the cache can be invalidated when underlying data changes.

**After the fix**
Re-run the profile. Confirm the hot path is gone. Check that the fix doesn't create a new bottleneck (e.g., cache memory growth vs CPU savings).
