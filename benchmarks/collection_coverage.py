"""Check when independent diagnostics actually ran, separately from PCM coverage."""
import math


def collection_coverage(rows, start, end, *, timestamp, max_gap=90, error=None):
    """Allow one minute of endpoint sampling slack, but never a post-run-only save.

    start/end and timestamp(row) use Unix seconds. Keep the original row order:
    sorting would conceal a clock regression. No samples are synthesized.
    """
    times = []
    invalid = 0
    errors = 0
    for row in rows:
        try:
            value = float(timestamp(row))
            if not math.isfinite(value):
                raise ValueError('non-finite timestamp')
            times.append(value)
            if error and start <= value <= end and error(row):
                errors += 1
        except (KeyError, ValueError, TypeError, OverflowError):
            invalid += 1
    ordered = all(b > a for a, b in zip(times, times[1:]))
    # Require actual samples inside the observation, including for short tests.
    inside = [t for t in times if start <= t <= end]
    gaps = [b - a for a, b in zip(inside, inside[1:])]
    head = inside[0] - start if inside else None
    tail = end - inside[-1] if inside else None
    maximum = max(gaps, default=0) if inside else None
    minimum_samples = 2 if end - start > max_gap else 1
    complete = (end > start and ordered and not invalid and not errors
                and len(inside) >= minimum_samples and head <= max_gap
                and tail <= max_gap and maximum <= max_gap)
    return dict(complete=complete, samples=len(times), inWindowSamples=len(inside),
                firstUnixSeconds=times[0] if times else None,
                lastUnixSeconds=times[-1] if times else None,
                headSeconds=head, tailSeconds=tail, maximumGapSeconds=maximum,
                allowedGapSeconds=max_gap, invalidRows=invalid,
                inWindowErrors=errors, strictlyIncreasing=ordered)
